import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueWorker } from '../src/services/queue/queueWorker.js';

const PENDING_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsPending'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry,ApprovalRequestLines";

const APPROVED_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsApproved'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry";

function createQueueStore() {
  const enqueued = [];
  const superseded = [];
  const queueStore = {
    knownStageKeys: new Set(),
    activeProcesses: [],
    async getKnownApprovalStageKeys() {
      return new Set(this.knownStageKeys);
    },
    async enqueue(item) {
      const key = `${item.approvalRequestId}:${item.currentStage}:${item.approverUserId}`;
      if (this.knownStageKeys.has(key)) {
        throw new Error('duplicate');
      }
      this.knownStageKeys.add(key);
      enqueued.push(item);
    },
    async getPendingItems() {
      return [];
    },
    async markProcessing() {},
    async markSent() {},
    async markFailed() {},
    async getActiveApprovalProcesses() {
      return this.activeProcesses;
    },
    async markSuperseded(processId, reason) {
      superseded.push({ processId, reason });
    },
  };
  return { queueStore, enqueued, superseded };
}

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test('pollOnce enqueues only actionable approvers and skips duplicate requests', async () => {
  const { queueStore, enqueued } = createQueueStore();

  const sapSessionManager = {
    async ensureLoggedIn() {
      return { ok: true };
    },
    client: {
      async get(path) {
        if (path === APPROVED_PATH) {
          return { data: [] };
        }
        assert.equal(path, PENDING_PATH);
        const stage1 = {
          Code: 101,
          Status: 'arsPending',
          CurrentStage: 1,
          ApprovalRequestLines: [{ UserID: 11, StageCode: 1, Status: 'ardPending' }],
        };
        const stage2 = {
          Code: 101,
          Status: 'arsPending',
          CurrentStage: 2,
          ApprovalRequestLines: [{ UserID: 22, StageCode: 2, Status: 'ardPending' }],
        };

        if (!this.calls) {
          this.calls = 0;
        }
        this.calls += 1;
        return {
          data: [this.calls === 1 ? stage1 : stage2],
        };
      },
    },
  };

  const worker = createQueueWorker({
    queueStore,
    sapSessionManager,
    logger: createLogger(),
    onNewApprovalQueued: () => {},
    postApprovedDraftFn: async () => ({}),
  });

  await worker.pollOnce();
  await worker.pollOnce();

  assert.equal(enqueued.length, 2);
  assert.deepEqual(enqueued[0], {
    approvalRequestId: 101,
    currentStage: 1,
    approverUserId: 11,
    approverPosition: 1,
    stageId: 1,
    draftEntry: undefined,
  });
  assert.deepEqual(enqueued[1], {
    approvalRequestId: 101,
    currentStage: 2,
    approverUserId: 22,
    approverPosition: 1,
    stageId: 2,
    draftEntry: undefined,
  });
});

test('pollOnce enqueues only the first pending approver for a SAP stage', async () => {
  const { queueStore, enqueued } = createQueueStore();

  const sapSessionManager = {
    async ensureLoggedIn() {
      return { ok: true };
    },
    client: {
      async get(path) {
        if (path === APPROVED_PATH) {
          return { data: [] };
        }
        assert.equal(path, PENDING_PATH);
        return {
          data: [
            {
              Code: 202,
              Status: 'arsPending',
              CurrentStage: 61,
              ApprovalRequestLines: [
                { UserID: 1, StageCode: 61, Status: 'ardPending' },
                { UserID: 72, StageCode: 61, Status: 'ardPending' },
              ],
            },
          ],
        };
      },
    },
  };

  const worker = createQueueWorker({
    queueStore,
    sapSessionManager,
    logger: createLogger(),
    onNewApprovalQueued: () => {},
    postApprovedDraftFn: async () => ({}),
  });

  await worker.pollOnce();

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0], {
    approvalRequestId: 202,
    currentStage: 61,
    approverUserId: 1,
    approverPosition: 1,
    stageId: 61,
    draftEntry: undefined,
  });
});

test('pollOnce retires links whose SAP request has vanished, keeps still-pending ones', async () => {
  const { queueStore, superseded } = createQueueStore();
  // Two live local links: 101 is still pending in SAP; 999 was deleted by an edit.
  queueStore.activeProcesses = [
    { id: 'p-live', approvalRequestId: 101, stage: 61, sapUserId: 11 },
    { id: 'p-stale', approvalRequestId: 999, stage: 61, sapUserId: 72 },
  ];

  const eligibilityCalls = [];
  const sapSessionManager = {
    async ensureLoggedIn() {
      return { ok: true };
    },
    client: {
      async get(path) {
        if (path === APPROVED_PATH) return { data: [] };
        assert.equal(path, PENDING_PATH);
        return {
          data: [
            {
              Code: 101,
              Status: 'arsPending',
              CurrentStage: 61,
              ApprovalRequestLines: [{ UserID: 11, StageCode: 61, Status: 'ardPending' }],
            },
          ],
        };
      },
    },
  };

  const worker = createQueueWorker({
    queueStore,
    sapSessionManager,
    logger: createLogger(),
    onNewApprovalQueued: () => {},
    postApprovedDraftFn: async () => ({}),
    confirmDecisionEligibility: async (params) => {
      eligibilityCalls.push(params);
      return { actionable: false, reason: 'request_not_found' };
    },
  });

  await worker.pollOnce();

  // Only the vanished request (999) is confirmed and retired; 101 is left live.
  assert.deepEqual(
    eligibilityCalls.map((c) => c.approvalRequestId),
    [999]
  );
  assert.deepEqual(superseded, [{ processId: 'p-stale', reason: 'request_not_found' }]);
});

test('pollOnce posts approved draft sales orders via SaveDraftToDocument', async () => {
  const { queueStore } = createQueueStore();
  const postedCalls = [];

  const sapSessionManager = {
    async ensureLoggedIn() {
      return { ok: true };
    },
    client: {
      async get(path) {
        if (path === PENDING_PATH) {
          return { data: [] };
        }
        assert.equal(path, APPROVED_PATH);
        return {
          data: [
            {
              Code: 301,
              Status: 'arsApproved',
              ObjectType: '17',
              IsDraft: 'Y',
              DraftEntry: 3,
            },
          ],
        };
      },
    },
  };

  const worker = createQueueWorker({
    queueStore,
    sapSessionManager,
    logger: createLogger(),
    onNewApprovalQueued: () => {},
    postApprovedDraftFn: async (sessionManager, draftEntry) => {
      postedCalls.push({ sessionManager, draftEntry });
      return { DocEntry: 42, DocNum: 1001 };
    },
  });

  await worker.pollOnce();
  await worker.pollOnce();

  assert.equal(postedCalls.length, 1);
  assert.equal(postedCalls[0].draftEntry, 3);
  assert.equal(postedCalls[0].sessionManager, sapSessionManager);
});

test('pollOnce skips approved drafts without DraftEntry and retries failed posts', async () => {
  const { queueStore } = createQueueStore();
  const postedCalls = [];
  let shouldFail = true;

  const sapSessionManager = {
    async ensureLoggedIn() {
      return { ok: true };
    },
    client: {
      async get(path) {
        if (path === PENDING_PATH) {
          return { data: [] };
        }
        assert.equal(path, APPROVED_PATH);
        return {
          data: [
            {
              Code: 401,
              Status: 'arsApproved',
              ObjectType: '17',
              IsDraft: 'Y',
            },
            {
              Code: 402,
              Status: 'arsApproved',
              ObjectType: '17',
              IsDraft: 'Y',
              DraftEntry: 9,
            },
          ],
        };
      },
    },
  };

  const worker = createQueueWorker({
    queueStore,
    sapSessionManager,
    logger: createLogger(),
    onNewApprovalQueued: () => {},
    postApprovedDraftFn: async (_sessionManager, draftEntry) => {
      postedCalls.push(draftEntry);
      if (shouldFail) {
        shouldFail = false;
        throw new Error('SAP unavailable');
      }
      return { DocEntry: 55 };
    },
  });

  await worker.pollOnce();
  assert.deepEqual(postedCalls, [9]);

  await worker.pollOnce();
  assert.deepEqual(postedCalls, [9, 9]);

  await worker.pollOnce();
  assert.deepEqual(postedCalls, [9, 9]);
});
