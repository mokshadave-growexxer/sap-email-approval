import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleFinalDocReconciliation } from '../src/services/audit/finalDocReconciler.js';

const silentLog = { info() {}, warn() {}, error() {} };

// Each response is an ApprovalRequest; ObjectEntry is set once IsDraft flips to 'N'.
function createHarness({ responses }) {
  const gets = [];
  const updates = [];
  const queue = [];
  let call = 0;

  const sessionManager = {
    async ensureLoggedIn() {},
    client: {
      async get(path) {
        gets.push(path);
        const response = responses[Math.min(call, responses.length - 1)];
        call += 1;
        return response;
      },
    },
  };

  const deps = {
    sessionManager,
    updateFn: async (id, finalDocEntry) => updates.push({ id, finalDocEntry }),
    log: silentLog,
    setTimeoutFn: (fn) => {
      queue.push(fn);
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
    initialDelayMs: 0,
    retryIntervalMs: 0,
    maxAttempts: 3,
  };

  async function drain() {
    while (queue.length) {
      const fn = queue.shift();
      await fn();
    }
  }

  return { deps, gets, updates, drain };
}

const draftAR = { data: { Status: 'arsApproved', IsDraft: 'Y', ObjectEntry: 0 } };
const convertedAR = (docEntry) => ({ data: { Status: 'arsApproved', IsDraft: 'N', ObjectEntry: docEntry } });

test('reconciler fills final_doc_entry from ObjectEntry once converted', async () => {
  const { deps, gets, updates, drain } = createHarness({ responses: [convertedAR(51077)] });
  scheduleFinalDocReconciliation({ decisionLogId: 'a', approvalRequestId: 130802, draftDocEntry: 101381 }, deps);
  await drain();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { id: 'a', finalDocEntry: 51077 });
  assert.match(gets[0], /^\/ApprovalRequests\(130802\)/);
});

test('reconciler waits while still a draft, then fills when converted', async () => {
  const { deps, gets, updates, drain } = createHarness({ responses: [draftAR, draftAR, convertedAR(52579)] });
  scheduleFinalDocReconciliation({ decisionLogId: 'b', approvalRequestId: 130810, draftDocEntry: 101396 }, deps);
  await drain();
  assert.equal(gets.length, 3);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].finalDocEntry, 52579);
});

test('reconciler gives up after max attempts if never converted', async () => {
  const { deps, gets, updates, drain } = createHarness({ responses: [draftAR] });
  scheduleFinalDocReconciliation({ decisionLogId: 'c', approvalRequestId: 999, draftDocEntry: 1 }, deps);
  await drain();
  assert.equal(gets.length, 3);
  assert.equal(updates.length, 0);
});

test('reconciler skips when approvalRequestId is missing', async () => {
  const { deps, gets, updates, drain } = createHarness({ responses: [convertedAR(1)] });
  scheduleFinalDocReconciliation({ decisionLogId: 'd', approvalRequestId: null, draftDocEntry: 1 }, deps);
  await drain();
  assert.equal(gets.length, 0);
  assert.equal(updates.length, 0);
});

test('reconciler survives a lookup error and keeps retrying', async () => {
  let call = 0;
  const gets = [];
  const updates = [];
  const queue = [];
  const deps = {
    sessionManager: {
      async ensureLoggedIn() {},
      client: {
        async get(path) {
          gets.push(path);
          call += 1;
          if (call === 1) throw new Error('SAP timeout');
          return convertedAR(777);
        },
      },
    },
    updateFn: async (id, finalDocEntry) => updates.push({ id, finalDocEntry }),
    log: silentLog,
    setTimeoutFn: (fn) => {
      queue.push(fn);
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
    initialDelayMs: 0,
    retryIntervalMs: 0,
    maxAttempts: 3,
  };
  scheduleFinalDocReconciliation({ decisionLogId: 'e', approvalRequestId: 62, draftDocEntry: 1 }, deps);
  while (queue.length) {
    const fn = queue.shift();
    await fn();
  }
  assert.equal(gets.length, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].finalDocEntry, 777);
});
