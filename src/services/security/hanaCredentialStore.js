import logger from '../../config/logger.js';
import { encryptSecret, decryptSecret } from './credentialCipher.js';
import { query, execute, udt } from '../sap/hanaClient.js';

const T = () => udt('AP_CREDENTIALS');

/**
 * @typedef {Readonly<{ userCode: string, found: boolean, password: string|null }>} ApproverCredential
 */

/**
 * The approver's stored SAP password, decrypted, keyed by SAP UserCode.
 * `found` is false (and `password` null) when the approver has never enrolled.
 *
 * @param {string} userCode
 * @returns {Promise<ApproverCredential>}
 */
export async function getApproverCredential(userCode) {
  const rows = await query(`SELECT "U_password" FROM ${T()} WHERE "Code" = ?`, [userCode]);
  if (!rows.length || rows[0].U_password == null) {
    return Object.freeze({ userCode, found: false, password: null });
  }
  return Object.freeze({ userCode, found: true, password: decryptSecret(rows[0].U_password) });
}

/**
 * Store (or replace) the approver's SAP password, encrypted at rest.
 *
 * @param {string} userCode
 * @param {string} plainPassword
 */
export async function upsertApproverCredential(userCode, plainPassword) {
  const encrypted = encryptSecret(plainPassword);
  const existing = await query(`SELECT "Code" FROM ${T()} WHERE "Code" = ?`, [userCode]);
  if (existing.length) {
    await execute(`UPDATE ${T()} SET "U_password" = ? WHERE "Code" = ?`, [encrypted, userCode]);
  } else {
    await execute(`INSERT INTO ${T()} ("Code", "Name", "U_password") VALUES (?, ?, ?)`, [userCode, userCode, encrypted]);
  }
  logger.info('hanaCredentialStore: stored approver credential', { userCode });
}
