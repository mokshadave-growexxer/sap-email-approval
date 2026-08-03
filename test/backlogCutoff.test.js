import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueWorker } from '../src/services/queue/queueWorker.js';

const PENDING_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsPending'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry,ApprovalRequestLines";
const APPROVED_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsApproved'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry";

const silentLogger = { info() {}, warn() {}, error() {} };

function queueStore() {
  const enqueued = [];
  return {
    enqueued,
    store: {
      knownStageKeys: new Set(),
      async getKnownApprovalStageKeys() {
        return new Set(this.knownStageKeys);
      },
      async enqueue(item) {
        this.knownStageKeys.add(`${item.approvalRequestId}:${item.currentStage}:${item.approverUserId}`);
        enqueued.push(item);
      },
      async markProcessing() {},
      async markSent() {},
      async markSkipped() {},
      async markFailed() {},
      async attachProcess() {},
      async getRetryableFailedItems() {
        return [];
      },
    },
  };
}

function sapWith(pending) {
  return {
    async ensureLoggedIn() {
      return { ok: true };
    },
    companyDb: 'TESTDB',
    client: {
      async get(path) {
        if (path === APPROVED_PATH) return { data: [] };
        assert.equal(path, PENDING_PATH);
        return { data: pending };
      },
    },
  };
}

test('backlog cutoff: only approval requests with WddCode > baseline are enqueued', async () => {
  const pending = [
    { Code: 100, Status: 'arsPending', CurrentStage: 1, ApprovalRequestLines: [{ UserID: 11, StageCode: 1, Status: 'ardPending' }] }, // old — skip
    { Code: 150, Status: 'arsPending', CurrentStage: 1, ApprovalRequestLines: [{ UserID: 12, StageCode: 1, Status: 'ardPending' }] }, // == baseline — skip
    { Code: 200, Status: 'arsPending', CurrentStage: 1, ApprovalRequestLines: [{ UserID: 13, StageCode: 1, Status: 'ardPending' }] }, // new — enqueue
  ];
  const { store, enqueued } = queueStore();
  const worker = createQueueWorker({
    queueStore: store,
    sapSessionManager: sapWith(pending),
    logger: silentLogger,
    onNewApprovalQueued: () => {},
    postApprovedDraftFn: async () => ({}),
    resolveBaselineFn: () => 150, // cutoff: skip everything <= 150
  });

  await worker.pollOnce();

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].approvalRequestId, 200);
});

test('backlog cutoff: nothing enqueued when every pending request is at/below the baseline', async () => {
  const pending = [
    { Code: 90, Status: 'arsPending', CurrentStage: 1, ApprovalRequestLines: [{ UserID: 11, StageCode: 1, Status: 'ardPending' }] },
    { Code: 100, Status: 'arsPending', CurrentStage: 1, ApprovalRequestLines: [{ UserID: 12, StageCode: 1, Status: 'ardPending' }] },
  ];
  const { store, enqueued } = queueStore();
  const worker = createQueueWorker({
    queueStore: store,
    sapSessionManager: sapWith(pending),
    logger: silentLogger,
    onNewApprovalQueued: () => {},
    postApprovedDraftFn: async () => ({}),
    resolveBaselineFn: () => 100,
  });

  await worker.pollOnce();
  assert.equal(enqueued.length, 0);
});
