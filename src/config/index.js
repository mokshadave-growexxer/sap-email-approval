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
