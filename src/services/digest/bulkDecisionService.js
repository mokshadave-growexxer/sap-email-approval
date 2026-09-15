import logger from '../../config/logger.js';
import { getProcess, PROCESS_STATUS } from '../approval/processStore.js';
import { materializePerProcessFootprint } from '../security/digestFootprintGate.js';
import { executeDecision, DECISION_OUTCOME } from '../approval/decisionExecutor.js';
import { ApprovalInvalidCredentialsError } from '../sap/approvalService.js';

// What happened to each selected SO in a bulk decision. The batch is applied one
// SO at a time; each SO still goes through the single, authoritative decision
// executor, so a bulk approve is exactly N independent instant approvals.
export const BULK_RESULT = Object.freeze({
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
  LOCKED: 'locked',
  FAILED: 'failed',
  ALREADY_DECIDED: 'already_decided',
  NOT_ACTIONABLE: 'not_actionable',
});

function emptyCounts() {
  return Object.fromEntries(Object.values(BULK_RESULT).map((code) => [code, 0]));
}

/**
 * Apply one action (approve|reject) to a set of selected processes for a single
 * approver. Guarantees:
 *  - a process is acted on only if it exists, is still pending, and belongs to
 *    THIS approver (never another approver's SO);
 *  - each decision runs through the shared decision executor (identical SAP
 *    semantics to the instant single-SO flow);
 *  - a rejected password aborts immediately, so a wrong password never decides a
 *    partial batch — the caller re-prompts and nothing was decided.
 *
 * @param {{
 *   sapUserId: string|number,
 *   action: 'approve'|'reject',
 *   selected: Array<string>,
 *   effectivePassword: string,
 *   remarks?: string,
 *   gateSession: object,
 * }} params
 * @param {object} [deps] - Injection seam for tests.
 * @returns {Promise<{ counts: object, anySuccess: boolean, credentialRejected: boolean }>}
 */
export async function runBulkDecision(
  { sapUserId, action, selected, effectivePassword, remarks = '', gateSession },
  deps = {}
) {
  const {
    getProcess: loadProcess = getProcess,
    materializePerProcessFootprint: materializeFootprint = materializePerProcessFootprint,
    executeDecision: decide = executeDecision,
    logger: log = logger,
  } = deps;

  const counts = emptyCounts();
  let anySuccess = false;
  let credentialRejected = false;

  for (const processId of selected) {
    const process = await loadProcess(processId);

    // Only ever act on this approver's own, still-pending process.
    if (!process || String(process.sap_user_id) !== String(sapUserId)) {
      counts[BULK_RESULT.NOT_ACTIONABLE] += 1;
      continue;
    }
    if (process.status !== PROCESS_STATUS.PENDING) {
      counts[BULK_RESULT.ALREADY_DECIDED] += 1;
      continue;
    }

    const footprint = await materializeFootprint({ gateSession, processId, draftEntry: process.draft_entry });

    let outcome;
    try {
      outcome = await decide({ process, action, effectivePassword, remarks, footprintSession: footprint });
    } catch (error) {
      if (error instanceof ApprovalInvalidCredentialsError) {
        // Same password for the whole batch: if it is wrong it is wrong for all.
        // Stop now so nothing is half-decided; the caller re-prompts.
        credentialRejected = true;
        break;
      }
      throw error;
    }

    switch (outcome.outcome) {
      case DECISION_OUTCOME.SUCCESS:
        counts[action === 'approve' ? BULK_RESULT.APPROVED : BULK_RESULT.REJECTED] += 1;
        anySuccess = true;
        break;
      case DECISION_OUTCOME.SUPERSEDED:
        counts[BULK_RESULT.SUPERSEDED] += 1;
        break;
      case DECISION_OUTCOME.LOCKED:
        counts[BULK_RESULT.LOCKED] += 1;
        break;
      case DECISION_OUTCOME.CLAIM_FAILED:
        counts[BULK_RESULT.ALREADY_DECIDED] += 1;
        break;
      default:
        counts[BULK_RESULT.FAILED] += 1;
        break;
    }
  }

  log.info('bulkDecisionService: batch complete', { sapUserId, action, counts, anySuccess, credentialRejected });
  return { counts, anySuccess, credentialRejected };
}
