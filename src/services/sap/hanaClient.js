import { config } from '../../config/index.js';
import logger from '../../config/logger.js';
import { currentSchema } from '../company/companyContext.js';

// One long-lived connection with serialized execution. HANA connections process
// one statement at a time, so all calls are chained to avoid overlap. Low
// concurrency (approval clicks + one poller) makes this ample.
//
// "Long-lived" is bounded, deliberately. A HANA session can be left in a state
// the server refuses to serve while the socket stays open and `state()` still
// reports 'connected' — a licence lockdown does exactly this, and the session
// is never released from it even after the server itself recovers. Such a
// session would otherwise be reused for the life of the process. Two guards
// prevent that: every unrecognised failure discards the connection (see
// runSerial), and no connection is reused for more than MAX_CONNECTION_AGE_MS.
let conn = null;
let connecting = null;
let connectedAt = 0;
let chain = Promise.resolve();

/** Hard ceiling on how long one connection is reused before being replaced. */
const MAX_CONNECTION_AGE_MS = 24 * 60 * 60 * 1000;

// Lazy-load the native driver so importing this module (e.g. in tests running
// the Postgres backend) never loads the addon or its background handles.
let driverPromise = null;
function getDriver() {
  if (!driverPromise) {
    driverPromise = import('@sap/hana-client').then((m) => m.default ?? m);
  }
  return driverPromise;
}

function connectOptions() {
  return {
    serverNode: `${config.hana.host}:${config.hana.port}`,
    uid: config.hana.user,
    pwd: config.hana.password,
    encrypt: false,
    sslValidateCertificate: false,
  };
}

async function openConnection() {
  const hanaPkg = await getDriver();
  return new Promise((resolve, reject) => {
    const c = hanaPkg.createConnection();
    c.connect(connectOptions(), (err) => (err ? reject(err) : resolve(c)));
  });
}

/** Drop the current connection, closing it best-effort. Never throws. */
function discardConnection() {
  if (!conn) return;
  try {
    conn.disconnect();
  } catch {
    /* the session may already be gone; nothing useful to do */
  }
  conn = null;
  connectedAt = 0;
}

async function ensureConnected() {
  if (conn) {
    const alive = conn.state && conn.state() === 'connected';
    const ageMs = Date.now() - connectedAt;
    if (alive && ageMs < MAX_CONNECTION_AGE_MS) {
      return conn;
    }
    if (alive) {
      logger.info('hanaClient: recycling connection at max age', { ageMs, maxAgeMs: MAX_CONNECTION_AGE_MS });
    }
    discardConnection();
  }
  if (!connecting) {
    connecting = openConnection()
      .then((c) => {
        conn = c;
        connectedAt = Date.now();
        logger.info('hanaClient: connected', { host: config.hana.host });
        return c;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

function rawExec(sql, params) {
  return new Promise((resolve, reject) => {
    conn.exec(sql, params, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function isConnectionError(error) {
  const msg = String(error?.message || error);
  return /not connected|connection.*(closed|lost|failed)|-10709|-10807/i.test(msg);
}

/**
 * Whether an error is a plain statement-level SQL error — bad syntax, unknown
 * column, constraint violation, insufficient privilege and the like. The
 * statement was wrong; the session is healthy and must be kept.
 *
 * HANA numbers these in the 257-399 band (plus 1299 "no data found"). Anything
 * outside it — including an error carrying no usable code — is treated as
 * possibly session-level, because the cost of being wrong is asymmetric:
 * needlessly reopening a connection costs milliseconds, while reusing a dead
 * one costs an outage that only a restart can end.
 *
 * Server-state failures are forced down the unhealthy path by message as well
 * as by code, so a licence lockdown is caught whatever code it arrives with.
 *
 * Exported for tests — the classification is the whole safety argument.
 */
export function isStatementError(error) {
  const msg = String(error?.message || error);
  if (/current state|locked[ -]?down|lockdown|licen[cs]e/i.test(msg)) {
    return false;
  }
  const code = Number(error?.code);
  if (!Number.isFinite(code)) {
    return false;
  }
  return (code >= 257 && code <= 399) || code === 1299;
}

async function runSerial(sql, params) {
  await ensureConnected();
  try {
    return await rawExec(sql, params);
  } catch (error) {
    // The statement never reached the server, so replaying it cannot duplicate
    // a write. This is the only case where a replay is safe.
    if (isConnectionError(error)) {
      logger.warn('hanaClient: reconnecting after connection error', { error: error?.message || String(error) });
      discardConnection();
      await ensureConnected();
      return rawExec(sql, params);
    }

    // Anything we cannot positively identify as a statement error: throw the
    // session away so the NEXT call opens a fresh one, but never replay this
    // statement — it may have committed before the error surfaced, and a
    // replayed INSERT would duplicate an approval row. The caller sees the
    // error it would have seen anyway; the queue worker's next poll recovers.
    if (!isStatementError(error)) {
      logger.warn('hanaClient: discarding session after unrecognised error', {
        error: error?.message || String(error),
        code: error?.code ?? null,
      });
      discardConnection();
    }

    throw error;
  }
}

/**
 * Serialized execution. Returns an array of row objects for SELECT, or the
 * affected-row count for INSERT/UPDATE/DELETE.
 */
export function exec(sql, params = []) {
  const result = chain.then(() => runSerial(sql, params));
  chain = result.catch(() => {});
  return result;
}

/** SELECT helper — always returns an array. */
export async function query(sql, params = []) {
  const rows = await exec(sql, params);
  return Array.isArray(rows) ? rows : [];
}

/** INSERT/UPDATE/DELETE helper — returns affected row count. */
export async function execute(sql, params = []) {
  const affected = await exec(sql, params);
  return typeof affected === 'number' ? affected : 0;
}

/** Schema-qualified, quoted UDT name for the active company, e.g. "ZZ_..."."@AP_APPROVAL". */
export function udt(name) {
  return `"${currentSchema()}"."@${name}"`;
}

/** Schema-qualified, quoted base-table name for the active company, e.g. "ZZ_..."."ORDR". */
export function table(name) {
  return `"${currentSchema()}"."${name}"`;
}

export async function disconnect() {
  discardConnection();
}
