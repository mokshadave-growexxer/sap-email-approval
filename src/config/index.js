import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateEnv } from '../utils/validateEnv.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Parse the configured SAP companies. This process serves ALL of them in one
 * runtime, isolated per request/poll by company context. `SAP_COMPANIES` is a
 * comma list of `key:schema` pairs; for SAP B1-on-HANA the HANA schema name and
 * the Service Layer CompanyDB name are the same string, so one value fills both.
 * With no list set, fall back to a single "default" company from the legacy
 * HANA_SCHEMA / SAP_COMPANY_DB variables.
 *
 * @returns {Array<{key: string, schema: string, companyDb: string}>}
 */
/**
 * Normalize a URL base path to either '' or '/segment[/segment...]' — a single
 * leading slash, no trailing slash. The app is served under this prefix (e.g.
 * '/salesorder') so it can share a host with other apps behind the reverse
 * proxy; every generated link and the route mount derive from it.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeBasePath(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value === '/') {
    return '';
  }
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

/**
 * Parse a cutoff timestamp (ISO 8601, ideally with an explicit offset) into a
 * Date, failing fast if it is unparseable so a misconfigured cutoff can never
 * silently disable the delivery guard.
 *
 * @param {string} raw
 * @returns {Date}
 */
export function parseCutoffDate(raw) {
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid cutoff timestamp: "${raw}". Use an ISO 8601 value, e.g. 2026-09-09T23:00:00+05:30.`);
  }
  return date;
}

/**
 * Parse the digest recipient allowlist (comma-separated emails). During rollout
 * the daily digest is delivered ONLY to these addresses; everyone else is
 * skipped. Normalized to lowercase, de-duplicated, blanks dropped.
 *
 * @param {string} raw
 * @returns {ReadonlyArray<string>}
 */
/** Parse an integer env value, falling back when it is unset/blank/non-numeric. */
export function intOrFallback(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseDigestAllowlist(raw) {
  const seen = new Set();
  for (const entry of String(raw ?? '').split(',')) {
    const email = entry.trim().toLowerCase();
    if (email) {
      seen.add(email);
    }
  }
  return Object.freeze([...seen]);
}

export function parseCompanies(companiesCsv, { fallbackSchema, fallbackCompanyDb } = {}) {
  const companies = String(companiesCsv || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, schema] = entry.split(':').map((part) => (part == null ? '' : part.trim()));
      if (!key || !schema) {
        throw new Error(`Invalid SAP_COMPANIES entry "${entry}" — expected "key:schema".`);
      }
      return { key, schema, companyDb: schema };
    });

  if (companies.length === 0) {
    if (fallbackSchema && fallbackCompanyDb) {
      return [{ key: 'default', schema: fallbackSchema, companyDb: fallbackCompanyDb }];
    }
    throw new Error('No SAP company configured: set SAP_COMPANIES ("key:schema,...") or HANA_SCHEMA + SAP_COMPANY_DB.');
  }

  const seen = new Set();
  for (const c of companies) {
    if (seen.has(c.key)) throw new Error(`Duplicate company key "${c.key}" in SAP_COMPANIES.`);
    seen.add(c.key);
  }
  return companies;
}

/**
 * Resolve a company's outbound email (SMTP) identity. Per-company variables are
 * `SMTP_<KEY>_{HOST,PORT,USER,PASS,FROM}` (KEY uppercased, e.g. SMTP_MSPL_FROM).
 * A company that declares its own mailbox (`SMTP_<KEY>_USER`) takes its user,
 * password and from-address ONLY from its own variables — it never inherits
 * another account's password — so it cannot accidentally send as, or with the
 * credentials of, a different company. HOST/PORT fall back to the global SMTP_*.
 * A company with no per-company USER uses the global sender entirely.
 *
 * @returns {{host: string, port: number, user: string, pass: string, from: string}}
 */
export function resolveCompanySmtp(key, globalSmtp, envSource = process.env) {
  const prefix = `SMTP_${String(key).toUpperCase()}_`;
  const pick = (suffix) => {
    const v = envSource[`${prefix}${suffix}`];
    return v == null || v === '' ? undefined : v;
  };
  const portRaw = pick('PORT');
  const port = portRaw ? Number.parseInt(portRaw, 10) : globalSmtp.port;
  const ownUser = pick('USER');
  const hasOwnMailbox = Boolean(ownUser);

  return {
    host: pick('HOST') ?? globalSmtp.host,
    port,
    user: hasOwnMailbox ? ownUser : globalSmtp.user,
    pass: hasOwnMailbox ? (pick('PASS') ?? '') : globalSmtp.pass,
    from: pick('FROM') ?? (hasOwnMailbox ? ownUser : globalSmtp.from),
  };
}

const env = validateEnv([
  { key: 'NODE_ENV', allowed: ['development', 'production', 'test'], default: 'development' },
  { key: 'PORT', parse: 'int', default: 3000 },
  { key: 'HOST', default: '0.0.0.0' },
  { key: 'APP_NAME', default: 'sap-email-approval' },
  { key: 'JWT_SECRET' },
  { key: 'JWT_EXPIRES_IN', default: '15m' },
  { key: 'CREDENTIALS_ENC_KEY' },
  // 0 (default) means the approval link never expires by time — it stays valid
  // until the request is decided (approved/rejected) or superseded. Set > 0 to
  // impose a time-to-live in hours.
  { key: 'APPROVAL_LINK_TTL_HOURS', parse: 'int', default: 0 },
  { key: 'FOOTPRINT_GEO_OPTIONAL', default: 'false', allowed: ['true', 'false'] },
  { key: 'HANA_HOST' },
  { key: 'HANA_PORT', parse: 'int', default: 30015 },
  { key: 'HANA_USER' },
  { key: 'HANA_PASSWORD' },
  { key: 'HANA_SCHEMA', default: '' },
  { key: 'SAP_COMPANIES', default: '' },
  { key: 'EMAIL_MODE', allowed: ['development', 'production'], default: 'development' },
  // Until this instant, EMAIL_MODE=development delivers only to the test
  // allowlist; at/after it, mail goes to the real approver. IST default.
  { key: 'EMAIL_ALLOWLIST_UNTIL', default: '2026-09-09T23:00:00+05:30' },
  // Only approval requests created on/after this date (the SO was punched or
  // updated then) are emailed/processed. Skips the historical backlog. IST date.
  { key: 'APPROVAL_MIN_CREATED_DATE', default: '2026-09-10' },
  // Blind-copied on every approval email (monitoring). Empty = no BCC.
  { key: 'EMAIL_BCC', default: 'sap1@matangiindustries.com' },
  // Scheduled daily digest of pending approvals (bulk approve/reject page).
  { key: 'DIGEST_ENABLED', default: 'true', allowed: ['true', 'false'] },
  // Global default send time (IST). Per-stage times below fall back to this when
  // their own value is not set.
  { key: 'DIGEST_SEND_HOUR_IST', parse: 'int', default: 10 },
  { key: 'DIGEST_SEND_MINUTE_IST', parse: 'int', default: 0 },
  // Per-stage send times (IST): approvers currently at the first approval stage
  // are digested at STAGE1, those at the second stage at STAGE2. Left blank here
  // so they are set in .env; blank falls back to the global time above.
  { key: 'DIGEST_STAGE1_SEND_HOUR_IST', default: '' },
  { key: 'DIGEST_STAGE1_SEND_MINUTE_IST', default: '' },
  { key: 'DIGEST_STAGE2_SEND_HOUR_IST', default: '' },
  { key: 'DIGEST_STAGE2_SEND_MINUTE_IST', default: '' },
  // During rollout the digest is delivered ONLY to these addresses. Set in .env
  // (DIGEST_ALLOWLIST); empty here so no recipient is ever hardcoded in source —
  // an unset allowlist means the digest sends to no one (fail-safe).
  { key: 'DIGEST_ALLOWLIST', default: '' },
  // How long a digest "Take Action" link stays valid after it is sent.
  { key: 'DIGEST_TOKEN_TTL_HOURS', parse: 'int', default: 36 },
  { key: 'RATE_LIMIT_WINDOW_MS', parse: 'int', default: 15 * 60 * 1000 },
  { key: 'RATE_LIMIT_MAX', parse: 'int', default: 100 },
  { key: 'CORS_ORIGIN', default: '*' },
  { key: 'SAP_BASE_URL' },
  { key: 'SAP_USERNAME' },
  { key: 'SAP_PASSWORD' },
  { key: 'SAP_COMPANY_DB', default: '' },
  { key: 'SAP_SESSION_RENEW_BEFORE_MS', parse: 'int', default: 14 * 60 * 1000 },
  { key: 'SAP_REJECT_UNAUTHORIZED', default: 'true', allowed: ['true', 'false'] },
  { key: 'APP_BASE_URL' },
  { key: 'BASE_PATH', default: '/salesorder' },
  { key: 'SMTP_HOST', default: '' },
  { key: 'SMTP_PORT', parse: 'int', default: 587 },
  { key: 'SMTP_USER', default: '' },
  { key: 'SMTP_PASS', default: '' },
  { key: 'SMTP_FROM', default: '' },
]);

const globalSmtp = {
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  user: env.SMTP_USER,
  pass: env.SMTP_PASS,
  from: env.SMTP_FROM,
};

// Optional per-company backlog cutoff: only SAP approval requests whose id
// (WddCode) is greater than this are ever emailed. Set APPROVAL_MIN_REQUEST_ID_<KEY>
// to freeze out the existing pending backlog permanently (survives restarts). If
// unset, the queue worker captures a baseline once at startup instead.
export function resolveMinRequestId(key, envSource = process.env) {
  const raw = envSource[`APPROVAL_MIN_REQUEST_ID_${String(key).toUpperCase()}`];
  if (raw == null || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

const companies = parseCompanies(env.SAP_COMPANIES, {
  fallbackSchema: env.HANA_SCHEMA,
  fallbackCompanyDb: env.SAP_COMPANY_DB,
}).map((c) => ({
  ...c,
  smtp: resolveCompanySmtp(c.key, globalSmtp),
  minRequestId: resolveMinRequestId(c.key),
}));

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  host: env.HOST,
  appName: env.APP_NAME,
  appBaseUrl: env.APP_BASE_URL,
  basePath: normalizeBasePath(env.BASE_PATH),
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  credentialsEncKey: env.CREDENTIALS_ENC_KEY,
  approvalLinkTtlHours: env.APPROVAL_LINK_TTL_HOURS,
  footprintGeoOptional: env.FOOTPRINT_GEO_OPTIONAL === 'true',
  emailMode: env.EMAIL_MODE,
  emailAllowlistUntil: parseCutoffDate(env.EMAIL_ALLOWLIST_UNTIL),
  approvalMinCreatedDate: env.APPROVAL_MIN_CREATED_DATE,
  emailBcc: env.EMAIL_BCC,
  digest: {
    enabled: env.DIGEST_ENABLED === 'true',
    sendHourIst: env.DIGEST_SEND_HOUR_IST,
    sendMinuteIst: env.DIGEST_SEND_MINUTE_IST,
    allowlist: parseDigestAllowlist(env.DIGEST_ALLOWLIST),
    tokenTtlHours: env.DIGEST_TOKEN_TTL_HOURS,
    // One send time per approval stage. Approvers currently at stage N are
    // digested at stageSchedules[N-1]'s time. A per-stage value left blank in
    // .env falls back to the global DIGEST_SEND_* time.
    stageSchedules: [
      {
        stage: 1,
        hour: intOrFallback(env.DIGEST_STAGE1_SEND_HOUR_IST, env.DIGEST_SEND_HOUR_IST),
        minute: intOrFallback(env.DIGEST_STAGE1_SEND_MINUTE_IST, env.DIGEST_SEND_MINUTE_IST),
      },
      {
        stage: 2,
        hour: intOrFallback(env.DIGEST_STAGE2_SEND_HOUR_IST, env.DIGEST_SEND_HOUR_IST),
        minute: intOrFallback(env.DIGEST_STAGE2_SEND_MINUTE_IST, env.DIGEST_SEND_MINUTE_IST),
      },
    ],
  },
  companies,
  companyHashSecret: env.JWT_SECRET,
  hana: {
    host: env.HANA_HOST,
    port: env.HANA_PORT,
    user: env.HANA_USER,
    password: env.HANA_PASSWORD,
  },
  rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: env.RATE_LIMIT_MAX,
  corsOrigin: env.CORS_ORIGIN,
  smtp: globalSmtp,
  sap: {
    baseUrl: env.SAP_BASE_URL,
    username: env.SAP_USERNAME,
    password: env.SAP_PASSWORD,
    sessionRenewBeforeMs: env.SAP_SESSION_RENEW_BEFORE_MS,
    rejectUnauthorized: env.SAP_REJECT_UNAUTHORIZED === 'true',
  },
};
