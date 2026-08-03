import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueWorker } from '../src/services/queue/queueWorker.js';

const silentLogger = { info() {}, warn() {}, error() {} };

function queueStore() {
  const enqueued = [];
  return {
    enqueued,
    store: {
      async getKnownApprovalStageKeys() {
        return new Set();
      },
      async enqueue(item) {
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

test('fetches ALL pending pages by following @odata.nextLink (not just the first page)', async () => {
  const line = (u) => ({ UserID: u, StageCode: 1, Status: 'ardPending' });
  const page1 = {
    value: [{ Code: 201, Status: 'arsPending', CurrentStage: 1, ApprovalRequestLines: [line(11)] }],
    '@odata.nextLink': 'ApprovalRequests?$skip=1&more=1',
  };
  const page2 = {
    value: [{ Code: 202, Status: 'arsPending', CurrentStage: 1, ApprovalRequestLines: [line(12)] }],
    // no nextLink -> last page
  };

  const sap = {
    async ensureLoggedIn() {
      return { ok: true };
    },
    companyDb: 'TESTDB',
    client: {
      async get(path) {
        if (path.includes("Status eq 'arsApproved'")) return { data: { value: [] } };
        if (path.includes('$skip=1')) return { data: page2 };
        return { data: page1 };
      },
    },
  };

  const { store, enqueued } = queueStore();
  const worker = createQueueWorker({
    queueStore: store,
    sapSessionManager: sap,
    logger: silentLogger,
    onNewApprovalQueued: () => {},
    postApprovedDraftFn: async () => ({}),
  });

  await worker.pollOnce();

  const codes = enqueued.map((e) => e.approvalRequestId).sort();
  assert.deepEqual(codes, [201, 202]); // both pages processed in one poll
});
