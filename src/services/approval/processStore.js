// Approval process lifecycle, stored in the SAP HANA UDT @AP_APPROVAL.
export { PROCESS_STATUS, PROCESS_FAILURE } from './processConstants.js';
export {
  createProcess,
  getProcess,
  claimProcess,
  markProcessDecided,
  releaseProcess,
  expireProcess,
  getApprovedProcessesForRequest,
} from './hanaApprovalStore.js';
