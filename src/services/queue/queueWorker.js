import logger from '../../config/logger.js';
import { sapSessionManager } from '../../sap/SapSessionManager.js';
import { postgresQueueStore } from './queueStore.js';
import { sendApprovalEmail } from '../email/approvalEmailService.js';
import { postApprovedDraft } from '../sap/approvalService.js';

const POLL_INTERVAL_MS = 30_000;

const PENDING_APPROVALS_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsPending'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'" +
  '&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry,ApprovalRequestLines';

const APPROVED_DRAFTS_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsApproved'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'" +
  '&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry';

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
  async markFailed() {},
});

const createDefaultLogger = () => logger;

export function getActionableApprovers(approvalRequest) {
  const lines = approvalRequest.ApprovalRequestLines || [];
  for (const [index, line] of lines.entries()) {
    if (Number(line.StageCode) !== Number(approvalRequest.CurrentStage)) {
      continue;
    }

    if (line.Status !== 'ardPending') {
      continue;
    }

    const priorPending = lines.slice(0, index).some(
      (previousLine) =>
        Number(previousLine.StageCode) === Number(approvalRequest.CurrentStage) &&
        previousLine.Status === 'ardPending'
    );

    if (priorPending) {
      break;
    }

    return [{ ...line, approverPosition: index + 1 }];
  }

  return [];
}

function buildStageKey(approvalRequestId, currentStage) {
  return `${String(approvalRequestId ?? '')}:${String(currentStage ?? '')}`;
}

function buildApprovalKey(approvalRequestId, currentStage, approverUserId) {
  return `${String(approvalRequestId ?? '')}:${String(currentStage ?? '')}:${String(approverUserId ?? '')}`;
}

function isKnownApprovalStage(knownStageKeys, approvalRequestId, currentStage, approverUserId) {
  return knownStageKeys.has(buildApprovalKey(approvalRequestId, currentStage, approverUserId));
}

function buildPostedDraftKey(approvalRequestId, draftEntry) {
  return `${String(approvalRequestId ?? '')}:${String(draftEntry ?? '')}`;
}

function normalizeApprovalList(response) {
  return response?.data?.value ?? response?.data ?? response ?? [];
}

export function createQueueWorker({
  queueStore = createDefaultQueueStore(),
  sapSessionManager: sessionManager = sapSessionManager,
  logger: workerLogger = createDefaultLogger(),
  onNewApprovalQueued = () => {},
  postApprovedDraftFn = postApprovedDraft,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  let pollTimer = null;
  /** @type {Set<string>} Drafts successfully posted in this process (avoid re-POSTing every poll). */
  const postedDraftKeys = new Set();

  async function fetchPendingApprovalRequests() {
    await sessionManager.ensureLoggedIn();

    try {
      workerLogger.info('queueWorker: polling SAP approval requests');
      const response = await sessionManager.client.get(PENDING_APPROVALS_PATH);
      const pending = normalizeApprovalList(response);
      workerLogger.info('queueWorker: SAP poll completed', {
        count: Array.isArray(pending) ? pending.length : 0,
      });
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
    await sessionManager.ensureLoggedIn();

    try {
      workerLogger.info('queueWorker: polling SAP approved draft requests');
      const response = await sessionManager.client.get(APPROVED_DRAFTS_PATH);
      const approved = normalizeApprovalList(response);
      workerLogger.info('queueWorker: approved draft poll completed', {
        count: Array.isArray(approved) ? approved.length : 0,
      });
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

    workerLogger.info('queueWorker: processing approved drafts', {
      approvedCount: approvedRequests.length,
    });

    for (const req of approvedRequests) {
      const approvalRequestId = req.Code ?? req.Id ?? req.approvalRequestId;
      const draftEntry = req.DraftEntry ?? req.draftEntry;

      if (draftEntry === undefined || draftEntry === null || draftEntry === '') {
        workerLogger.warn('queueWorker: approved draft missing DraftEntry, skipping', {
          approvalRequestId,
        });
        continue;
      }

      const postedKey = buildPostedDraftKey(approvalRequestId, draftEntry);
      if (postedDraftKeys.has(postedKey)) {
        workerLogger.info('queueWorker: draft already posted in this process, skipping', {
          approvalRequestId,
          draftEntry,
        });
        continue;
      }

      try {
        const salesOrder = await postApprovedDraftFn(sessionManager, draftEntry);
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

    if (!Array.isArray(pendingRequests) || pendingRequests.length === 0) {
      workerLogger.info('queueWorker: no pending SAP approvals found');
      return;
    }

    const known = new Set([...(await queueStore.getKnownApprovalStageKeys())].map((value) => String(value)));
    workerLogger.info('queueWorker: processing pending approvals', {
      pendingCount: pendingRequests.length,
      knownCount: known.size,
    });

    for (const req of pendingRequests) {
      const approvalRequestId = req.Code ?? req.Id ?? req.approvalRequestId;
      const currentStage = req.CurrentStage ?? req.currentStage;

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

          await queueStore.enqueue(item);
          known.add(buildApprovalKey(approvalRequestId, currentStage, approverUserId));
          workerLogger.info('queueWorker: enqueued new approval', item);
          await onNewApprovalQueued(item);
        } catch (error) {
          workerLogger.warn('queueWorker: enqueue skipped/failed', {
            approvalRequestId: req.Code,
            error: error?.message || String(error),
          });
        }
      }
    }
  }

  async function pollOnce() {
    await pollPendingApprovals();
    await processApprovedDrafts();
  }

  function start() {
    if (pollTimer) return;
    workerLogger.info('queueWorker: starting', { intervalMs: pollIntervalMs });
    pollTimer = setInterval(() => {
      pollOnce().catch((error) =>
        workerLogger.error('queueWorker: unhandled error in poll cycle', {
          error: error?.message || String(error),
        })
      );
    }, pollIntervalMs);

    pollOnce().catch((error) =>
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
    };

export const queueWorker = createQueueWorker({
  queueStore: postgresQueueStore,
  onNewApprovalQueued: notifyOnNewApprovalQueued,
});
export const { pollOnce, start, stop, fetchPendingApprovalRequests, fetchApprovedDraftRequests, processApprovedDrafts } =
  queueWorker;
export const queueStore = postgresQueueStore;
export default queueWorker;
