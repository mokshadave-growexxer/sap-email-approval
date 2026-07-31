// Approver SAP credentials, stored in the SAP HANA UDT @AP_CREDENTIALS.
export { UnknownApproverError } from './approverErrors.js';
export { upsertApproverCredential, getApproverPassword, hasApproverCredential } from './hanaCredentialStore.js';
