import logger from '../../config/logger.js';
import { config } from '../../config/index.js';
import { listCompanies, runInCompany, currentSL, currentCompany } from '../company/companyContext.js';
import { queueStore as backendQueueStore } from './queueStore.js';
import { sendApprovalEmail } from '../email/approvalEmailService.js';
import { ApprovalService, postApprovedDraft } from '../sap/approvalService.js';
import {
  PENDING_APPROVALS_PATH,
  APPROVED_DRAFTS_PATH,
  isBeforeCreatedCutoff,
  getActionableApprovers,
  getAllPages,
} from '../sap/approvalRequestQueries.js';

const POLL_INTERVAL_MS = 30_000;
const EMAIL_MAX_SEND_ATTEMPTS = 5;
const EMAIL_RETRY_BACKOFF_MINUTES = 2;

const createDefaultQueueStore = () => ({
  async getKnownApprovalStageKeys() {
    return new Set();
  },
  async enqueue() {
    throw new Error('queueStore.enqueue not implemented');
  },
  async getPendingItems() {
    return [];
  },
  async markProcessing() {},
  async markSent() {},
  async markSkipped() {},
  async markFailed() {},
  async attachProcess() {},
  async getRetryableFailedItems() {
    return [];
  },
  async getActiveApprovalProcesses() {
    return [];
  },
  async markSuperseded() {},
});

const createDefaultLogger = () => logger;

function buildStageKey(approvalRequestId, currentStage) {
  return `${String(approvalRequestId ?? '')}:${String(currentStage ?? '')}`;
}

function buildApprovalKey(approvalRequestId, currentStage, approverUserId) {
  return `${String(approvalRequestId ?? '')}:${String(currentStage ?? '')}:${String(approverUserId ?? '')}`;
}

function isKnownApprovalStage(knownStageKeys, approvalRequestId, currentStage, approverUserId) {
  return knownStageKeys.has(buildApprovalKey(approvalRequestId, currentStage, approverUserId));
}

function buildPostedDraftKey(companyDb, approvalRequestId, draftEntry) {
  return `${String(companyDb ?? '')}:${String(approvalRequestId ?? '')}:${String(draftEntry ?? '')}`;
}

function normalizeApprovalList(response) {
  return response?.data?.value ?? response?.data ?? response ?? [];
}

export function createQueueWorker({
  queueStore = createDefaultQueueStore(),
  sapSessionManager: injectedSessionManager = null,
  logger: workerLogger = createDefaultLogger(),
  onNewApprovalQueued = () => {},
  postApprovedDraftFn = postApprovedDraft,
  pollIntervalMs = POLL_INTERVAL_MS,
  emailMaxSendAttempts = EMAIL_MAX_SEND_ATTEMPTS,
  emailRetryBackoffMinutes = EMAIL_RETRY_BACKOFF_MINUTES,
  resolveBaselineFn = null,
  resolveCreatedCutoffFn = null,
  confirmDecisionEligibility = null,
} = {}) {
  let pollTimer = null;
  /** @type {Set<string>} Drafts successfully posted in this process (avoid re-POSTing every poll). Keyed by company. */
  const postedDraftKeys = new Set();

  // The active company's Service Layer session, unless one was injected (tests).
  const resolveSession = () => injectedSessionManager ?? currentSL();

  // Backlog cutoff: by default every pending request is emailed. Set a per-company
  // APPROVAL_MIN_REQUEST_ID_<KEY> to permanently skip an older backlog — only
  // requests with WddCode > that value are then emailed. This is an explicit,
  // restart-stable cutoff (never auto-captured, so a restart can't freeze out
  // legitimate pending Sales Orders).
  function defaultResolveBaseline() {
    if (injectedSessionManager) return -Infinity; // injected tests: no company context
    return currentCompany().minRequestId ?? -Infinity;
  }
  const resolveBaseline = resolveBaselineFn ?? defaultResolveBaseline;

  // Date cutoff: only requests created on/after this date are handled. Disabled
  // (null) under an injected session so unit tests are date-agnostic.
  function defaultResolveCreatedCutoff() {
    if (injectedSessionManager) return null;
    return config.approvalMinCreatedDate ?? null;
  }
  const resolveCreatedCutoff = resolveCreatedCutoffFn ?? defaultResolveCreatedCutoff;

  // Authoritative per-request eligibility check (SAP is the source of truth).
  // Injected in tests; in production it reads the active company's session.
  const confirmEligibility =
    confirmDecisionEligibility ??
    ((params) => new ApprovalService(injectedSessionManager).getDecisionEligibility(params));

  // Retire links whose SAP request has vanished (the originator edited the
  // pending draft, deleting its request) or was decided elsewhere (the add-on).
  // Only a request absent from the current SAP pending set is a candidate, and
  // each candidate is confirmed authoritatively before being superseded — a
  // transient/partial poll can never wrongly retire a live link.
  async function reconcileSupersededLinks(pendingSapRequests) {
    let active;
    try {
      active = await queueStore.getActiveApprovalProcesses();
    } catch (error) {
      workerLogger.warn('queueWorker: could not load active links for reconciliation', {
        error: error?.message || String(error),
      });
      return;
    }
    if (!Array.isArray(active) || active.length === 0) return;

    const pendingIds = new Set(
      (pendingSapRequests || []).map((r) => String(r.Code ?? r.Id ?? r.approvalRequestId))
    );

    for (const link of active) {
      if (pendingIds.has(String(link.approvalRequestId))) continue;
      try {
        const eligibility = await confirmEligibility({
          approvalRequestId: link.approvalRequestId,
          approverUserId: link.sapUserId,
          stage: link.stage,
        });
        if (eligibility && eligibility.actionable === false) {
          await queueStore.markSuperseded(link.id, eligibility.reason);
          workerLogger.info('queueWorker: retired superseded approval link', {
            processId: link.id,
            approvalRequestId: link.approvalRequestId,
            reason: eligibility.reason,
          });
        }
      } catch (error) {
        workerLogger.warn('queueWorker: eligibility re-check failed; leaving link for next cycle', {
          processId: link.id,
          error: error?.message || String(error),
        });
      }
    }
  }

  async function fetchPendingApprovalRequests() {
    await resolveSession().ensureLoggedIn();

    try {
      workerLogger.info('queueWorker: polling SAP approval requests');
      const pending = await getAllPages(resolveSession(), PENDING_APPROVALS_PATH);
      workerLogger.info('queueWorker: SAP poll completed', { count: pending.length });
      return pending;
    } catch (error) {
      workerLogger.error('queueWorker: SAP request failed', {
        status: error?.response?.status,
        sapError: JSON.stringify(error?.response?.data),
      });
      throw error;
    }
  }

  async function fetchApprovedDraftRequests() {
    await resolveSession().ensureLoggedIn();

    try {
      workerLogger.info('queueWorker: polling SAP approved draft requests');
      const approved = await getAllPages(resolveSession(), APPROVED_DRAFTS_PATH);
      workerLogger.info('queueWorker: approved draft poll completed', { count: approved.length });
      return approved;
    } catch (error) {
      workerLogger.error('queueWorker: approved draft SAP request failed', {
        status: error?.response?.status,
        sapError: JSON.stringify(error?.response?.data),
      });
      throw error;
    }
  }

  async function processApprovedDrafts() {
    let approvedRequests;
    try {
      approvedRequests = await fetchApprovedDraftRequests();
    } catch (error) {
      workerLogger.error('queueWorker.processApprovedDrafts: failed to fetch from SAP', {
        error: error?.message || String(error),
      });
      return;
    }

    if (!Array.isArray(approvedRequests) || approvedRequests.length === 0) {
      workerLogger.info('queueWorker: no approved draft sales orders found');
      return;
    }

    const createdCutoff = resolveCreatedCutoff();
    workerLogger.info('queueWorker: processing approved drafts', {
      approvedCount: approvedRequests.length,
      createdCutoff,
    });

    for (const req of approvedRequests) {
      const approvalRequestId = req.Code ?? req.Id ?? req.approvalRequestId;
      const draftEntry = req.DraftEntry ?? req.draftEntry;

      // Don't convert the historical backlog — only Sales Orders on/after cutoff.
      if (isBeforeCreatedCutoff(req.CreationDate, createdCutoff)) continue;

      if (draftEntry === undefined || draftEntry === null || draftEntry === '') {
        workerLogger.warn('queueWorker: approved draft missing DraftEntry, skipping', {
          approvalRequestId,
        });
        continue;
      }

      const postedKey = buildPostedDraftKey(resolveSession().companyDb, approvalRequestId, draftEntry);
      if (postedDraftKeys.has(postedKey)) {
        workerLogger.info('queueWorker: draft already posted in this process, skipping', {
          approvalRequestId,
          draftEntry,
        });
        continue;
      }

      try {
        const salesOrder = await postApprovedDraftFn(resolveSession(), draftEntry);
        postedDraftKeys.add(postedKey);
        workerLogger.info('queueWorker: posted approved draft sales order', {
          approvalRequestId,
          draftEntry,
          docEntry: salesOrder?.DocEntry ?? salesOrder?.docEntry ?? null,
          docNum: salesOrder?.DocNum ?? salesOrder?.docNum ?? null,
        });
      } catch (error) {
        workerLogger.error('queueWorker: failed to post approved draft', {
          approvalRequestId,
          draftEntry,
          error: error?.message || String(error),
          sapError: error?.meta?.cause ?? error?.response?.data ?? null,
        });
      }
    }
  }

  async function pollPendingApprovals() {
    let pendingRequests;
    try {
      pendingRequests = await fetchPendingApprovalRequests();
    } catch (error) {
      workerLogger.error('queueWorker.pollOnce: failed to fetch from SAP', {
        error: error?.message || String(error),
      });
      return;
    }

    // Retire any local links whose SAP request has vanished or been decided
    // elsewhere, so an edited/superseded link stops being live within one cycle.
    await reconcileSupersededLinks(pendingRequests);

    if (!Array.isArray(pendingRequests) || pendingRequests.length === 0) {
      workerLogger.info('queueWorker: no pending SAP approvals found');
      return;
    }

    const baseline = resolveBaseline(pendingRequests);
    const createdCutoff = resolveCreatedCutoff();
    const known = new Set([...(await queueStore.getKnownApprovalStageKeys())].map((value) => String(value)));
    workerLogger.info('queueWorker: processing pending approvals', {
      pendingCount: pendingRequests.length,
      knownCount: known.size,
      baseline,
      createdCutoff,
    });

    for (const req of pendingRequests) {
      const approvalRequestId = req.Code ?? req.Id ?? req.approvalRequestId;
      const currentStage = req.CurrentStage ?? req.currentStage;

      // Skip the pre-existing backlog — only requests newer than the cutoff.
      if (Number(approvalRequestId) <= baseline) continue;
      // Skip Sales Orders punched/updated before the go-live date cutoff.
      if (isBeforeCreatedCutoff(req.CreationDate, createdCutoff)) continue;

      const actionable = getActionableApprovers(req);
      if (actionable.length === 0) continue;

      for (const line of actionable) {
        try {
          const approverUserId = line.UserID ?? line.UserId ?? line.ApproverUserID ?? line.ApproverUserId;
          const item = {
            approvalRequestId,
            currentStage,
            approverUserId,
            approverPosition: line.approverPosition ?? null,
            stageId: currentStage,
            draftEntry: req.DraftEntry ?? req.draftEntry ?? req.ObjectEntry ?? req.objectEntry,
          };

          if (!approvalRequestId || approverUserId == null) {
            continue;
          }

          if (isKnownApprovalStage(known, approvalRequestId, currentStage, approverUserId)) {
            workerLogger.info('queueWorker: approval already known, skipping email', {
              approvalRequestId,
              currentStage,
              approverUserId,
            });
            continue;
          }

          const queueId = await queueStore.enqueue(item);
          known.add(buildApprovalKey(approvalRequestId, currentStage, approverUserId));
          workerLogger.info('queueWorker: enqueued new approval', item);
          await attemptSend(queueId, item);
        } catch (error) {
          workerLogger.warn('queueWorker: enqueue skipped/failed', {
            approvalRequestId: req.Code,
            error: error?.message || String(error),
          });
        }
      }
    }
  }

  /**
   * Send one approval email and record the outcome on its queue row:
   *   sent    -> delivered; never resent
   *   skipped -> intentionally not sent (e.g. test allowlist); never resent
   *   failed  -> send errored; eligible for retry
   * The process id is captured even on failure so a retry reuses the same link.
   */
  async function attemptSend(queueId, item) {
    try {
      const result = await onNewApprovalQueued(item);

      if (result && result.skipped) {
        if (queueId != null) await queueStore.markSkipped(queueId, result.reason);
        workerLogger.info('queueWorker: email not sent (skipped)', {
          approvalRequestId: item.approvalRequestId,
          approverUserId: item.approverUserId,
          reason: result.reason,
        });
        return;
      }

      if (queueId != null) {
        if (result && result.processId) await queueStore.attachProcess(queueId, result.processId);
        await queueStore.markSent(queueId);
      }
      workerLogger.info('queueWorker: email sent', {
        approvalRequestId: item.approvalRequestId,
        approverUserId: item.approverUserId,
        processId: result?.processId ?? null,
      });
    } catch (error) {
      if (queueId != null) {
        if (error && error.processId) await queueStore.attachProcess(queueId, error.processId);
        await queueStore.markFailed(queueId, error?.message || String(error));
      }
      workerLogger.warn('queueWorker: email send failed (will retry)', {
        approvalRequestId: item.approvalRequestId,
        approverUserId: item.approverUserId,
        error: error?.message || String(error),
      });
    }
  }

  async function retryFailedEmails() {
    let items;
    try {
      items = await queueStore.getRetryableFailedItems({
        maxAttempts: emailMaxSendAttempts,
        backoffMinutes: emailRetryBackoffMinutes,
      });
    } catch (error) {
      workerLogger.error('queueWorker.retryFailedEmails: failed to load retryable items', {
        error: error?.message || String(error),
      });
      return;
    }

    if (!Array.isArray(items) || items.length === 0) {
      return;
    }

    workerLogger.info('queueWorker: retrying failed approval emails', { count: items.length });

    for (const row of items) {
      const item = {
        approvalRequestId: row.approval_request_id,
        currentStage: row.current_stage,
        approverUserId: row.approver_user_id,
        approverPosition: row.approver_position ?? null,
        stageId: row.current_stage,
        draftEntry: row.draft_entry ?? undefined,
        processId: row.process_id ?? undefined,
      };
      await attemptSend(row.id, item);
    }
  }

  async function pollOnce() {
    await pollPendingApprovals();
    await retryFailedEmails();
    await processApprovedDrafts();
  }

  // Production entry point: run one poll cycle for every configured company,
  // each inside its own company context (schema + Service Layer session), so a
  // company only ever sees its own drafts, approvers, and stored data. When a
  // session is injected (tests) there is a single implicit company.
  async function pollOnceAllCompanies() {
    if (injectedSessionManager) {
      return pollOnce();
    }
    for (const company of listCompanies()) {
      try {
        await runInCompany(company, () => pollOnce());
      } catch (error) {
        workerLogger.error('queueWorker: poll cycle failed for company', {
          company: company.key,
          error: error?.message || String(error),
        });
      }
    }
  }

  function start() {
    if (pollTimer) return;
    workerLogger.info('queueWorker: starting', {
      intervalMs: pollIntervalMs,
      companies: injectedSessionManager ? ['(injected)'] : listCompanies().map((c) => c.key),
    });
    pollTimer = setInterval(() => {
      pollOnceAllCompanies().catch((error) =>
        workerLogger.error('queueWorker: unhandled error in poll cycle', {
          error: error?.message || String(error),
        })
      );
    }, pollIntervalMs);

    pollOnceAllCompanies().catch((error) =>
      workerLogger.error('queueWorker: unhandled error in initial poll', {
        error: error?.message || String(error),
      })
    );
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      workerLogger.info('queueWorker: stopped');
    }
  }

  return {
    pollOnce,
    start,
    stop,
    fetchPendingApprovalRequests,
    fetchApprovedDraftRequests,
    processApprovedDrafts,
    retryFailedEmails,
  };
}

const hasEmailConfig =
  Boolean(process.env.APP_BASE_URL) &&
  Boolean(process.env.SMTP_HOST) &&
  Boolean(process.env.SMTP_FROM);

const notifyOnNewApprovalQueued = hasEmailConfig
  ? sendApprovalEmail
  : async (item) => {
      logger.warn('queueWorker: SMTP is not configured, skipping approval email', {
        approvalRequestId: item?.approvalRequestId,
        approverUserId: item?.approverUserId,
      });
      return { skipped: true, reason: 'smtp_not_configured' };
    };

export const queueWorker = createQueueWorker({
  queueStore: backendQueueStore,
  onNewApprovalQueued: notifyOnNewApprovalQueued,
});
export const { pollOnce, start, stop, fetchPendingApprovalRequests, fetchApprovedDraftRequests, processApprovedDrafts } =
  queueWorker;
export const queueStore = backendQueueStore;
// Re-exported for backward compatibility with earlier import sites.
export { getActionableApprovers };
export default queueWorker;
