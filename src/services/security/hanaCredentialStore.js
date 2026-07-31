import logger from '../../config/logger.js';
import { encryptSecret, decryptSecret } from './credentialCipher.js';
import { UnknownApproverError } from './approverErrors.js';
import { query, execute, udt } from '../sap/hanaClient.js';

const T = () => udt('AP_CREDENTIALS');

export async function upsertApproverCredential(userCode, plainPassword) {
  const encrypted = encryptSecret(plainPassword);
  const existing = await query(`SELECT "Code" FROM ${T()} WHERE "Code" = ?`, [userCode]);
  if (existing.length) {
    await execute(`UPDATE ${T()} SET "U_password" = ? WHERE "Code" = ?`, [encrypted, userCode]);
  } else {
    await execute(`INSERT INTO ${T()} ("Code", "Name", "U_password") VALUES (?, ?, ?)`, [userCode, userCode, encrypted]);
  }
  logger.info('hanaCredentialStore: upserted approver credential', { userCode });
}

export async function getApproverPassword(userCode) {
  const rows = await query(`SELECT "U_password" FROM ${T()} WHERE "Code" = ?`, [userCode]);
  if (!rows.length) {
    throw new UnknownApproverError(userCode);
  }
  return decryptSecret(rows[0].U_password);
}

export async function hasApproverCredential(userCode) {
  const rows = await query(`SELECT "Code" FROM ${T()} WHERE "Code" = ?`, [userCode]);
  return rows.length > 0;
}
