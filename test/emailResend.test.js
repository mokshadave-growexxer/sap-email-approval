import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueWorker } from '../src/services/queue/queueWorker.js';

const PENDING_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsPending'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry,ApprovalRequestLines";
const APPROVED_PATH =
  "/ApprovalRequests?$filter=Status%20eq%20'arsApproved'%20and%20ObjectType%20eq%20'17'%20and%20IsDraft%20eq%20'Y'&$select=Code,Status,CurrentStage,ObjectType,IsDraft,ObjectEntry,DraftEntry";

const silentLogger = { info() {}, warn() {}, error() {} };

// In-memory implementation of the queueStore contract used by the worker.
function memQueueStore() {
  const rows = new Map();
  let seq = 0;
  const keyOf = (r) => `${r.approval_request_id}:${r.current_stage}:${r.approver_user_id}`;
  return {
    rows,
    async getKnownApprovalStageKeys() {
      return new Set([...rows.values()].map(keyOf));
    },
    async enqueue(item) {
      const key = `${item.approvalRequestId}:${item.currentStage}:${item.approverUserId}`;
      for (const r of rows.values()) if (keyOf(r) === key) return r.id;
      const id = ++seq;
      rows.set(id, {
        id,
        approval_request_id: item.approvalRequestId,
        current_stage: item.currentStage,
        approver_user_id: item.approverUserId,
        approver_position: item.approverPosition ?? null,
        draft_entry: item.draftEntry ?? null,
        process_id: null,
        status: 'pending',
        attempts: 0,
        last_error: null,
      });
      return id;
    },
    async getPendingItems() {
      return [];
    },
    async markProcessing() {},
    async markSent(id) {
      rows.get(id).status = 'sent';
    },
    async markSkipped(id, reason) {
      const r = rows.get(id);
      r.status = 'skipped';
      r.last_error = reason ?? null;
    },
    async markFailed(id, err) {
      const r = rows.get(id);
      r.status = 'failed';
      r.attempts += 1;
      r.last_error = err;
    },
    async attachProcess(id, processId) {
      rows.get(id).process_id = processId;
    },
    async getRetryableFailedItems({ maxAttempts }) {
      // Backoff ignored in tests so cycles are deterministic.
      return [...rows.values()].filter((r) => r.status === 'failed' && r.attempts < maxAttempts);
    },
  };
}

function sapWithOnePendingApprover() {
  return {
    async ensureLoggedIn() {},
    client: {
      async get(path) {
        if (path === APPROVED_PATH) return { data: [] };
        assert.equal(path, PENDING_PATH);
        return {
          data: [
            {
              Code: 500,
              Status: 'arsPending',
              CurrentStage: 1,
              DraftEntry: 55,
              ApprovalRequestLines: [{ UserID: 3, StageCode: 1, Status: 'ardPending' }],
            },
          ],
        };
      },
    },
  };
}

test('delivered email is marked sent and never resent (even while approver is pending)', async () => {
  const store = memQueueStore();
  let sends = 0;
  const worker = createQueueWorker({
    queueStore: store,
    sapSessionManager: sapWithOnePendingApprover(),
    logger: silentLogger,
    postApprovedDraftFn: async () => ({}),
    onNewApprovalQueued: async () => {
      sends += 1;
      return { processId: 'proc-1' };
    },
  });

  await worker.pollOnce();
  await worker.pollOnce(); // approver has NOT acted; must not resend

  const row = [...store.rows.values()][0];
  assert.equal(row.status, 'sent');
  assert.equal(row.process_id, 'proc-1');
  assert.equal(sends, 1);
});

test('failed send is retried and reuses the same process/link, then marked sent', async () => {
  const store = memQueueStore();
  const seenProcessIds = [];
  let call = 0;
  const worker = createQueueWorker({
    queueStore: store,
    sapSessionManager: sapWithOnePendingApprover(),
    logger: silentLogger,
    postApprovedDraftFn: async () => ({}),
    onNewApprovalQueued: async (item) => {
      call += 1;
      seenProcessIds.push(item.processId ?? null);
      if (call === 1) {
        const err = new Error('SMTP down');
        err.processId = 'proc-9'; // link was created before send failed
        throw err;
      }
      return { processId: item.processId ?? 'proc-9' };
    },
  });

  await worker.pollOnce(); // send fails -> failed, then retry in same cycle -> sent

  const row = [...store.rows.values()][0];
  assert.equal(row.status, 'sent');
  assert.equal(row.process_id, 'proc-9');
  assert.equal(call, 2);
  assert.equal(seenProcessIds[0], null); // first attempt: fresh
  assert.equal(seenProcessIds[1], 'proc-9'); // retry: reused the same link
});

test('allowlist-skipped email is marked skipped and never retried', async () => {
  const store = memQueueStore();
  let sends = 0;
  const worker = createQueueWorker({
    queueStore: store,
    sapSessionManager: sapWithOnePendingApprover(),
    logger: silentLogger,
    postApprovedDraftFn: async () => ({}),
    onNewApprovalQueued: async () => {
      sends += 1;
      return { skipped: true, reason: 'recipient_not_in_test_allowlist' };
    },
  });

  await worker.pollOnce();
  await worker.pollOnce();

  const row = [...store.rows.values()][0];
  assert.equal(row.status, 'skipped');
  assert.equal(row.process_id, null);
  assert.equal(sends, 1);
});

test('retries stop after the max attempt cap', async () => {
  const store = memQueueStore();
  let sends = 0;
  const worker = createQueueWorker({
    queueStore: store,
    sapSessionManager: sapWithOnePendingApprover(),
    logger: silentLogger,
    postApprovedDraftFn: async () => ({}),
    emailMaxSendAttempts: 3,
    onNewApprovalQueued: async () => {
      sends += 1;
      throw new Error('SMTP down');
    },
  });

  await worker.pollOnce(); // attempt 1 (initial) + retries until attempts == 3
  await worker.pollOnce(); // nothing left to retry

  const row = [...store.rows.values()][0];
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 3);
  assert.equal(sends, 3);
});
