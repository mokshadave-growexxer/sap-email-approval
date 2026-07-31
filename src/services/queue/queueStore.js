// Email queue / dedup / resend, merged into the SAP HANA UDT @AP_APPROVAL.
import * as hana from '../approval/hanaApprovalStore.js';

export const queueStore = {
  getKnownApprovalStageKeys: (...a) => hana.getKnownApprovalStageKeys(...a),
  enqueue: (...a) => hana.enqueue(...a),
  getPendingItems: (...a) => hana.getPendingItems(...a),
  markProcessing: (...a) => hana.markProcessing(...a),
  markSent: (...a) => hana.markSent(...a),
  markSkipped: (...a) => hana.markSkipped(...a),
  markFailed: (...a) => hana.markFailed(...a),
  attachProcess: (...a) => hana.attachProcess(...a),
  getRetryableFailedItems: (...a) => hana.getRetryableFailedItems(...a),
};

export default queueStore;
