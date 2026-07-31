import { config } from '../../config/index.js';
import logger from '../../config/logger.js';
import { currentSchema } from '../company/companyContext.js';

// One long-lived connection with serialized execution. HANA connections process
// one statement at a time, so all calls are chained to avoid overlap. Low
// concurrency (approval clicks + one poller) makes this ample.
let conn = null;
let connecting = null;
let chain = Promise.resolve();

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

async function ensureConnected() {
  if (conn && conn.state && conn.state() === 'connected') return conn;
  if (!connecting) {
    connecting = openConnection()
      .then((c) => {
        conn = c;
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

async function runSerial(sql, params) {
  await ensureConnected();
  try {
    return await rawExec(sql, params);
  } catch (error) {
    if (isConnectionError(error)) {
      logger.warn('hanaClient: reconnecting after connection error', { error: error?.message || String(error) });
      conn = null;
      await ensureConnected();
      return rawExec(sql, params);
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
  if (conn) {
    try {
      conn.disconnect();
    } catch {
      /* ignore */
    }
    conn = null;
  }
}
