import logger from '../../config/logger.js';
import {
  ApprovalService,
  ApprovalDocumentLockedError,
  ApprovalInvalidCredentialsError,
  ApprovalSapError,
  ApprovalStageAdvancedError,
  ApprovalUnauthorizedError,
} from '../sap/approvalService.js';
import { claimProcess, markProcessDecided, markProcessSuperseded, releaseProcess } from './processStore.js';
import { createPendingDecision, markDecisionFailed, markDecisionSuccess } from '../audit/decisionLogService.js';
import { writeDecisionRemark } from '../sap/decisionRemarkStore.js';
import { linkApprovalFootprintsToDocument } from '../sap/footprintDocumentLinker.js';
import { getSalesOrderChangeStatus } from '../sap/draftStatusService.js';
import { scheduleFinalDocReconciliation } from '../audit/finalDocReconciler.js';
import { currentCompany } from '../company/companyContext.js';

const ACTIONS = Object.freeze({ APPROVE: 'approve', REJECT: 'reject' });

// The result of deciding ONE approval process. Every path resolves to exactly
// one of these (except invalid credentials, which is thrown so callers can
// re-prompt for the password). Shared by the single-SO route and the bulk digest
// route, so both go through byte-for-byte identical SAP semantics.
export const DECISION_OUTCOME = Object.freeze({
  SUCCESS: 'success',
  SUPERSEDED: 'superseded',
  LOCKED: 'locked',
  FAILED: 'failed',
  CLAIM_FAILED: 'claim_failed',
});

let sharedApprovalService = null;
function defaultApprovalService() {
  if (!sharedApprovalService) {
    sharedApprovalService = new ApprovalService();
  }
  return sharedApprovalService;
}

function toHumanMessage(error) {
  if (error instanceof ApprovalUnauthorizedError) return 'You are not authorized to approve or reject this request.';
  if (error instanceof ApprovalSapError && error.meta?.friendlyMessage) return error.meta.friendlyMessage;
  // Never surface raw SAP/internal error detail to the browser.
  return 'Your SAP password could not be verified, or the decision could not be completed. Please check your password and try again.';
}

/**
 * Decide one approval process (approve or reject) against SAP, with the exact
 * claim → audit → decide → verify → post-draft → footprint-link lifecycle the
 * single-SO flow uses. The footprint session for THIS process must already be
 * recorded (its session_id becomes the process's footprint id).
 *
 * @param {{
 *   process: object,                 // process row DTO (id, approval_request_id, stage, sap_user_id, user_code, ...)
 *   action: 'approve'|'reject',
 *   effectivePassword: string,       // resolved credential (stored or typed)
 *   remarks?: string,
 *   footprintSession: object,        // recorded footprint session for this process
 * }} params
 * @param {object} [deps] - Injection seam for tests.
 * @returns {Promise<Readonly<object>>} A DECISION_OUTCOME-tagged result.
 * @throws {ApprovalInvalidCredentialsError} when SAP rejects the password.
 */
export async function executeDecision(
  { process, action, effectivePassword, remarks = '', footprintSession },
  deps = {}
) {
  const {
    approvalService = defaultApprovalService(),
    claimProcess: claim = claimProcess,
    releaseProcess: release = releaseProcess,
    markProcessDecided: decided = markProcessDecided,
    markProcessSuperseded: superseded = markProcessSuperseded,
    createPendingDecision: pending = createPendingDecision,
    markDecisionSuccess: recordSuccess = markDecisionSuccess,
    markDecisionFailed: recordFailure = markDecisionFailed,
    writeDecisionRemark: writeRemark = writeDecisionRemark,
    linkApprovalFootprintsToDocument: linkFootprints = linkApprovalFootprintsToDocument,
    scheduleFinalDocReconciliation: scheduleReconcile = scheduleFinalDocReconciliation,
    getSalesOrderChangeStatus: changeStatus = getSalesOrderChangeStatus,
    currentCompany: company = currentCompany,
    logger: log = logger,
  } = deps;

  const processId = process.id;
  const approvalRequestId = process.approval_request_id;

  // One-time, race-safe claim (pending -> processing). Guards against a second
  // click, the instant link, the digest link, and the SAP add-on all colliding.
  const claimResult = await claim(processId);
  if (!claimResult.ok) {
    return Object.freeze({ outcome: DECISION_OUTCOME.CLAIM_FAILED, reason: claimResult.reason, approvalRequestId });
  }

  const { id: decisionLogId } = await pending({
    processId,
    approvalRequestId,
    action,
    approverUserId: process.sap_user_id,
    userCode: process.user_code,
    approverEmail: process.approver_email,
    session: footprintSession,
  });

  let result;
  try {
    const params = {
      approvalRequestId,
      approverUserId: process.sap_user_id,
      approverUsername: process.user_code,
      approverPassword: effectivePassword,
      expectedStage: process.stage,
      remarks: remarks || '',
    };
    result =
      action === ACTIONS.APPROVE
        ? await approvalService.approveRequest(params)
        : await approvalService.rejectRequest(params);
  } catch (error) {
    // A concurrent edit holds the document open in SAP: keep the link usable.
    if (error instanceof ApprovalDocumentLockedError) {
      await release(processId);
      await recordFailure(decisionLogId, 'document_locked');
      log.info('decisionExecutor: decision blocked by document lock', { processId });
      return Object.freeze({ outcome: DECISION_OUTCOME.LOCKED, approvalRequestId });
    }

    // The stage was decided in SAP (add-on) between page load and submit — retire.
    if (error instanceof ApprovalStageAdvancedError) {
      const reason = error.meta?.reason || 'stage_advanced';
      await superseded(processId, reason);
      await recordFailure(decisionLogId, `superseded:${reason}`);
      log.info('decisionExecutor: decision superseded by SAP add-on', { processId, reason });
      return Object.freeze({ outcome: DECISION_OUTCOME.SUPERSEDED, reason, approvalRequestId });
    }

    // SAP rejected the password: release and let the caller re-prompt for it.
    if (error instanceof ApprovalInvalidCredentialsError) {
      await release(processId);
      await recordFailure(decisionLogId, 'invalid_credentials');
      log.info('decisionExecutor: SAP rejected approver credentials', { processId });
      throw error;
    }

    if (error instanceof ApprovalSapError) {
      log.error('decisionExecutor: SAP decision failed', {
        approvalRequestId: error.meta?.approvalRequestId,
        decisionStatus: error.meta?.decisionStatus,
        cause: error.meta?.cause,
        message: error.message,
      });
    }

    await release(processId);
    await recordFailure(decisionLogId, error?.message || String(error));
    return Object.freeze({
      outcome: DECISION_OUTCOME.FAILED,
      approvalRequestId,
      message: toHumanMessage(error),
      unauthorized: error instanceof ApprovalUnauthorizedError,
    });
  }

  await decided(processId, action);

  const after = result?.sapResponse?.after;
  const draftDocEntry = after?.DraftEntry ?? result?.draftPost?.draftEntry ?? process.draft_entry ?? null;
  // The final Sales Order DocEntry: from SaveDraftToDocument, or the request's
  // ObjectEntry once IsDraft flips to 'N'.
  const draftPostFinal = result?.draftPost?.success
    ? result.draftPost.result?.DocEntry ?? result.draftPost.result?.docEntry ?? null
    : null;
  const objectEntryFinal =
    after && String(after.IsDraft) === 'N' && Number(after.ObjectEntry) > 0 ? Number(after.ObjectEntry) : null;
  const syncFinalDocEntry = draftPostFinal ?? objectEntryFinal;

  await recordSuccess(decisionLogId, {
    sapResponse: result?.sapResponse ?? null,
    timezone: footprintSession?.timezone,
    draftDocEntry,
    finalDocEntry: syncFinalDocEntry,
  });

  // Surface the remark in SAP's Approval Status Report (WDD1.Remarks).
  const remarkText = (remarks || '').trim();
  if (remarkText) {
    await writeRemark({ approvalRequestId, sapUserId: process.sap_user_id, remark: remarkText });
  }

  // The CREATED/UPDATED signal must be read from the pre-decision snapshot.
  const changeType = changeStatus(result?.sapResponse?.before).code;

  if (action === ACTIONS.APPROVE && result?.currentStatus === 'arsApproved') {
    if (syncFinalDocEntry != null) {
      linkFootprints({ approvalRequestId, docEntry: syncFinalDocEntry, changeType }).catch(() => {});
    } else {
      scheduleReconcile({
        decisionLogId,
        approvalRequestId,
        draftDocEntry,
        company: company(),
        onResolved: (docEntry) => linkFootprints({ approvalRequestId, docEntry, changeType }),
      });
    }
  }

  const draftPostWarning =
    result?.draftPost?.attempted && result.draftPost.success === false
      ? result.draftPost.error ||
        'Approval succeeded, but the approved draft could not be posted. Manual or automatic retry is required.'
      : '';

  return Object.freeze({
    outcome: DECISION_OUTCOME.SUCCESS,
    approvalRequestId: result.approvalRequestId,
    currentStatus: result.currentStatus ?? null,
    draftPostWarning,
  });
}
