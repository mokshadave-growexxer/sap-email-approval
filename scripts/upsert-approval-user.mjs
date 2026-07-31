#!/usr/bin/env node
// Admin utility: store (or replace) an approver's SAP password, encrypted at rest,
// in a specific company's schema.
//
// Usage:
//   node scripts/upsert-approval-user.mjs <companyKey> <UserCode> <Password>
//
// companyKey is one of the keys in SAP_COMPANIES (e.g. millp, mspl). The password
// is encrypted with CREDENTIALS_ENC_KEY (from .env) before it touches the
// database. Re-running for the same UserCode replaces the password.
import '../src/config/index.js';
import { runInCompany, currentSchema, getCompanyByKey } from '../src/services/company/companyContext.js';
import { upsertApproverCredential } from '../src/services/security/userCredentialStore.js';
import { disconnect as hanaDisconnect } from '../src/services/sap/hanaClient.js';

const [companyKey, userCode, password] = process.argv.slice(2);

if (!companyKey || !userCode || !password) {
  console.error('Usage: node scripts/upsert-approval-user.mjs <companyKey> <UserCode> <Password>');
  process.exit(1);
}

if (!getCompanyByKey(companyKey)) {
  console.error(`Unknown company key "${companyKey}". Check SAP_COMPANIES in .env.`);
  process.exit(1);
}

try {
  await runInCompany(companyKey, async () => {
    await upsertApproverCredential(userCode, password);
    console.log(`Stored encrypted credential for "${userCode}" in SAP HANA (${currentSchema()}).`);
  });
} catch (error) {
  console.error('Failed to store credential:', error.message);
  process.exitCode = 1;
} finally {
  await hanaDisconnect();
}
