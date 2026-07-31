export const PROCESS_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
});

export const PROCESS_FAILURE = Object.freeze({
  NOT_FOUND: 'process not found',
  EXPIRED: 'approval link expired',
  ALREADY_DECIDED: 'approval already decided',
});

export const DECISION_STATUS_BY_ACTION = Object.freeze({
  approve: PROCESS_STATUS.APPROVED,
  reject: PROCESS_STATUS.REJECTED,
});
