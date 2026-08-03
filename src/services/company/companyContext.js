import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { config } from '../../config/index.js';
import { getSessionManager } from '../../sap/SapSessionManager.js';

/**
 * Multi-tenant company context. One process serves every configured SAP
 * company; the active company for a unit of work (an HTTP request or one
 * queue-poll cycle) is carried ambiently via AsyncLocalStorage so low-level
 * code (HANA schema qualifier, Service Layer client) never has to be threaded
 * with a company argument. Reading the context outside a company scope THROWS —
 * a wrong-schema access is impossible by construction.
 *
 * Each company is addressed in approval links by an opaque hash of its schema
 * (HMAC with the app secret), so real schema/company names never appear in URLs.
 */

const als = new AsyncLocalStorage();

function hashSchema(schema) {
  return crypto.createHmac('sha256', config.companyHashSecret).update(schema).digest('hex').slice(0, 32);
}

const byKey = new Map();
const byHash = new Map();

for (const c of config.companies) {
  const entry = Object.freeze({
    key: c.key,
    schema: c.schema,
    companyDb: c.companyDb,
    smtp: c.smtp,
    minRequestId: c.minRequestId ?? null,
    hash: hashSchema(c.schema),
  });
  byKey.set(entry.key, entry);
  byHash.set(entry.hash, entry);
}

/** @returns {ReadonlyArray<{key: string, schema: string, companyDb: string, hash: string}>} */
export function listCompanies() {
  return [...byKey.values()];
}

export function getCompanyByKey(key) {
  return byKey.get(key) || null;
}

export function getCompanyByHash(hash) {
  return byHash.get(String(hash || '')) || null;
}

/**
 * Run `fn` with the given company as the active context. Accepts a company
 * object (from list/get helpers) or a company key. Attaches that company's
 * Service Layer session manager to the context.
 */
export function runInCompany(companyOrKey, fn) {
  const company = typeof companyOrKey === 'string' ? byKey.get(companyOrKey) : companyOrKey;
  if (!company) {
    throw new Error(`Unknown company: ${JSON.stringify(companyOrKey)}`);
  }
  const store = { ...company, sl: getSessionManager(company.companyDb) };
  return als.run(store, fn);
}

/** The active company context, or throw if called outside `runInCompany`. */
export function currentCompany() {
  const store = als.getStore();
  if (!store) {
    throw new Error('No active company context — this operation must run inside runInCompany().');
  }
  return store;
}

export function currentSchema() {
  return currentCompany().schema;
}

export function currentCompanyHash() {
  return currentCompany().hash;
}

export function currentSL() {
  return currentCompany().sl;
}
