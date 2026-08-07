export const PROCESS_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  // Decided directly in SAP (e.g. the approval add-on), never through this
  // service. The email link is retired without a local decision record.
  SUPERSEDED: 'superseded',
});

export const PROCESS_FAILURE = Object.freeze({
  NOT_FOUND: 'process not found',
  EXPIRED: 'approval link expired',
  ALREADY_DECIDED: 'approval already decided',
  SUPERSEDED: 'decided directly in sap',
});

export const DECISION_STATUS_BY_ACTION = Object.freeze({
  approve: PROCESS_STATUS.APPROVED,
  reject: PROCESS_STATUS.REJECTED,
});
