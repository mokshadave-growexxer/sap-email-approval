import { currentSL, runInCompany } from '../company/companyContext.js';
import logger from '../../config/logger.js';
import { updateFinalDocEntry } from './decisionLogService.js';

const MAX_ATTEMPTS = 5;
const INITIAL_DELAY_MS = 30_000;
const RETRY_INTERVAL_MS = 60_000;

/**
 * Once the Vendor add-on converts the approved draft into a Sales Order, SAP
 * flips the ApprovalRequest's IsDraft to 'N' and sets ObjectEntry to the new
 * document's DocEntry. That ObjectEntry IS the final document entry.
 */
async function lookupFinalDocEntry(sessionManager, approvalRequestId) {
  await sessionManager.ensureLoggedIn();
  const response = await sessionManager.client.get(
    `/ApprovalRequests(${encodeURIComponent(approvalRequestId)})?$select=Status,IsDraft,ObjectEntry`
  );
  const ar = response?.data ?? response;
  const converted = String(ar?.IsDraft) === 'N' && Number(ar?.ObjectEntry) > 0;
  return converted ? Number(ar.ObjectEntry) : null;
}

/**
 * Schedule a best-effort follow-up that fills final_doc_entry once the approved
 * draft has been converted into a Sales Order. The approval response is never
 * blocked on this; a persistent miss is a reconciliation gap to report, not an
 * approval failure.
 *
 * @param {{decisionLogId: (number|string), approvalRequestId: (number|string), draftDocEntry?: number|string}} job
 * @param {object} [deps] - Injection seam for tests.
 * @returns {{cancel: () => void}}
 */
export function scheduleFinalDocReconciliation(
  { decisionLogId, approvalRequestId, draftDocEntry, onResolved, company = null },
  {
    sessionManager = null,
    updateFn = updateFinalDocEntry,
    log = logger,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    initialDelayMs = INITIAL_DELAY_MS,
    retryIntervalMs = RETRY_INTERVAL_MS,
    maxAttempts = MAX_ATTEMPTS,
  } = {}
) {
  if (approvalRequestId === undefined || approvalRequestId === null || approvalRequestId === '') {
    log.warn('finalDocReconciler: no approvalRequestId, skipping reconciliation', { decisionLogId });
    return { cancel: () => {} };
  }

  let timer = null;
  let attempts = 0;

  // Re-establish the company context for this deferred work: the timer fires
  // long after the request scope, so SL/schema must be pinned to the company
  // captured at schedule time. Tests inject sessionManager and omit company.
  const withCompany = (fn) => (company ? runInCompany(company, fn) : fn());

  async function attempt() {
    attempts += 1;
    try {
      const finalDocEntry = await withCompany(async () => {
        const sm = sessionManager ?? currentSL();
        const resolved = await lookupFinalDocEntry(sm, approvalRequestId);
        if (resolved !== null && resolved !== undefined) {
          await updateFn(decisionLogId, resolved);
          if (typeof onResolved === 'function') {
            try {
              await onResolved(resolved);
            } catch (error) {
              log.warn('finalDocReconciler: onResolved failed', { decisionLogId, error: error?.message || String(error) });
            }
          }
        }
        return resolved;
      });
      if (finalDocEntry !== null && finalDocEntry !== undefined) {
        log.info('finalDocReconciler: reconciled final_doc_entry', {
          decisionLogId,
          approvalRequestId,
          draftDocEntry,
          finalDocEntry,
          attempts,
        });
        return;
      }
      log.info('finalDocReconciler: draft not converted yet', { decisionLogId, approvalRequestId, attempts });
    } catch (error) {
      log.warn('finalDocReconciler: lookup attempt failed', {
        decisionLogId,
        approvalRequestId,
        attempts,
        error: error?.message || String(error),
      });
    }

    if (attempts >= maxAttempts) {
      log.warn('finalDocReconciler: gave up reconciling final_doc_entry (reconciliation gap)', {
        decisionLogId,
        approvalRequestId,
        attempts,
      });
      return;
    }

    timer = setTimeoutFn(attempt, retryIntervalMs);
  }

  timer = setTimeoutFn(attempt, initialDelayMs);
  if (typeof timer?.unref === 'function') {
    timer.unref();
  }

  return {
    cancel: () => {
      if (timer) clearTimeoutFn(timer);
    },
  };
}
