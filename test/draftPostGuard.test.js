// The DocEntry burn guard.
//
// SAP keeps the ORDR.DocEntry it allocates even when the add rolls back, so the
// number of POSTs is the number of burned Sales Order numbers. These tests pin
// the one property that matters: a draft that cannot post is POSTed ONCE, not
// once per 30s poll.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// Point the state file at a throwaway directory BEFORE config is imported.
const STATE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-post-state-'));
process.env.DRAFT_POST_STATE_DIR = STATE_DIR;

const { postDraftGuarded } = await import('../src/services/sap/draftPostGuard.js');
const { classifyDraftPostFailure, DRAFT_POST_FAILURE } = await import('../src/services/sap/draftPostErrors.js');
const state = await import('../src/services/sap/draftPostState.js');
const { signDraftRetryToken, verifyDraftRetryToken } = await import('../src/utils/draftRetryToken.js');

let companySeq = 0;
/** A fresh company key per test, so each gets its own isolated state file. */
function freshCompany() {
  state.__resetCache();
  return `TESTCO${++companySeq}`;
}

function sapError(code, message, status = 400) {
  const error = new Error(message);
  error.response = { status, data: { error: { code, message: { value: message } } } };
  return error;
}

// --- classification -------------------------------------------------------

test('business rejections are permanent — retrying only burns DocEntry', () => {
  for (const [code, message] of [
    ['-5002', 'Quantity falls below the minimum inventory level'],
    ['-10', 'Customer exceeds credit limit'],
    ['-1', 'Item is blocked for sales'],
  ]) {
    const verdict = classifyDraftPostFailure(sapError(code, message));
    assert.equal(verdict.classification, DRAFT_POST_FAILURE.PERMANENT, `${code} should be permanent`);
    assert.equal(verdict.retryable, false);
  }
});

test('a locked posting period is permanent, not a record lock', () => {
  // "lock" appears in both, but only one means "someone else has it open".
  // Treating a closed period as transient would put it on the retry path and
  // burn a DocEntry per attempt — the exact bug this guard exists to stop.
  assert.equal(
    classifyDraftPostFailure(sapError('-2028', 'Posting period is locked')).classification,
    DRAFT_POST_FAILURE.PERMANENT
  );
  assert.equal(
    classifyDraftPostFailure(sapError('-2028', 'Record is locked by another user')).classification,
    DRAFT_POST_FAILURE.TRANSIENT
  );
});

test('locks, session loss and 5xx are transient', () => {
  assert.equal(
    classifyDraftPostFailure(sapError('-1029', 'Record is being modified by another user')).classification,
    DRAFT_POST_FAILURE.TRANSIENT
  );
  assert.equal(
    classifyDraftPostFailure(sapError('301', 'Invalid session', 401)).classification,
    DRAFT_POST_FAILURE.TRANSIENT
  );
  assert.equal(
    classifyDraftPostFailure(sapError('500', 'Internal error', 503)).classification,
    DRAFT_POST_FAILURE.TRANSIENT
  );
});

test('a dropped socket is ambiguous and must be verified, never blindly re-posted', () => {
  const error = new Error('socket hang up');
  error.code = 'ECONNRESET';
  const verdict = classifyDraftPostFailure(error);
  assert.equal(verdict.classification, DRAFT_POST_FAILURE.AMBIGUOUS);
  assert.equal(verdict.mustVerify, true);
});

test('an unrecognised failure defaults to permanent (fail safe, not fail loud)', () => {
  const verdict = classifyDraftPostFailure(sapError('-9999', 'Something nobody has seen before'));
  assert.equal(verdict.classification, DRAFT_POST_FAILURE.PERMANENT);
});

// --- the core guarantee ---------------------------------------------------

test('a permanently failing draft is POSTed exactly once, no matter how many polls run', async () => {
  const companyKey = freshCompany();
  let posts = 0;
  const parked = [];

  // 120 cycles = one hour of the real 30s poll.
  for (let cycle = 0; cycle < 120; cycle += 1) {
    await postDraftGuarded({
      companyKey,
      approvalRequestId: 7001,
      draftEntry: 4242,
      post: async () => {
        posts += 1;
        throw sapError('-5002', 'Quantity falls below the minimum inventory level');
      },
      verify: async () => null,
      onParked: (info) => parked.push(info),
    });
  }

  assert.equal(posts, 1, 'exactly one DocEntry may be burned, not one per poll');
  assert.equal(parked.length, 1, 'the human is alerted exactly once');
  assert.equal(parked[0].parkReason, 'permanent_failure');

  const record = await state.getRecord(companyKey, 7001, 4242);
  assert.equal(record.state, 'parked');
});

test('a parked draft stays parked across a restart (state survives in the file)', async () => {
  const companyKey = freshCompany();
  let posts = 0;

  await postDraftGuarded({
    companyKey,
    approvalRequestId: 7002,
    draftEntry: 5150,
    post: async () => {
      posts += 1;
      throw sapError('-5002', 'Credit limit exceeded');
    },
    verify: async () => null,
    onParked: () => {},
  });
  assert.equal(posts, 1);

  // Simulate a process restart: drop every in-memory cache, re-read the file.
  state.__resetCache();

  for (let i = 0; i < 20; i += 1) {
    await postDraftGuarded({
      companyKey,
      approvalRequestId: 7002,
      draftEntry: 5150,
      post: async () => {
        posts += 1;
        throw sapError('-5002', 'Credit limit exceeded');
      },
      verify: async () => null,
      onParked: () => {},
    });
  }

  assert.equal(posts, 1, 'a restart must not resume the burn');
});

test('transient failures retry on a bounded budget, then park', async () => {
  const companyKey = freshCompany();
  let posts = 0;
  const parked = [];

  // Backoff is skipped by clearing nextAttemptAt between cycles, which is what
  // the passage of time does in production.
  for (let i = 0; i < 10; i += 1) {
    await postDraftGuarded({
      companyKey,
      approvalRequestId: 7003,
      draftEntry: 6060,
      post: async () => {
        posts += 1;
        throw sapError('-1029', 'Record is being modified by another user');
      },
      verify: async () => null,
      onParked: (info) => parked.push(info),
    });
    const record = await state.getRecord(companyKey, 7003, 6060);
    if (record.state === 'retrying') {
      await state.markRetrying(companyKey, 7003, 6060, {
        attempts: record.attempts,
        nextAttemptAt: null,
        classification: record.classification,
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
      });
    }
  }

  assert.equal(posts, 5, 'four backoff retries plus the original attempt, then stop');
  assert.equal(parked.length, 1);
  assert.equal(parked[0].parkReason, 'transient_retries_exhausted');
});

test('backoff blocks a retry until its window opens', async () => {
  const companyKey = freshCompany();
  let posts = 0;

  const attempt = () =>
    postDraftGuarded({
      companyKey,
      approvalRequestId: 7004,
      draftEntry: 7070,
      post: async () => {
        posts += 1;
        throw sapError('-1029', 'Record is being modified by another user');
      },
      verify: async () => null,
      onParked: () => {},
    });

  await attempt();
  assert.equal(posts, 1);

  const result = await attempt();
  assert.equal(result.reason, 'backoff');
  assert.equal(posts, 1, 'the second poll inside the backoff window must not post');
});

test('a draft that already converted is never re-POSTed (no burn, no duplicate order)', async () => {
  const companyKey = freshCompany();
  let posts = 0;

  // First attempt dies with an ambiguous socket error — SAP may have committed.
  await postDraftGuarded({
    companyKey,
    approvalRequestId: 7005,
    draftEntry: 8080,
    post: async () => {
      posts += 1;
      const error = new Error('socket hang up');
      error.code = 'ECONNRESET';
      throw error;
    },
    verify: async () => null,
    onParked: () => {},
  });
  assert.equal(posts, 1);

  // Clear the backoff, then let verify report that SAP did commit after all.
  const record = await state.getRecord(companyKey, 7005, 8080);
  await state.markRetrying(companyKey, 7005, 8080, {
    attempts: record.attempts,
    nextAttemptAt: null,
    classification: record.classification,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
  });

  const result = await postDraftGuarded({
    companyKey,
    approvalRequestId: 7005,
    draftEntry: 8080,
    post: async () => {
      posts += 1;
      throw new Error('must not be called');
    },
    verify: async () => 998877,
    onParked: () => {},
  });

  assert.equal(posts, 1, 'the draft had already converted — posting again would duplicate it');
  assert.equal(result.reason, 'already_converted');
  assert.equal(result.docEntry, 998877);
});

test('a draft that cannot be verified is skipped rather than posted blind', async () => {
  const companyKey = freshCompany();
  let posts = 0;

  await postDraftGuarded({
    companyKey,
    approvalRequestId: 7006,
    draftEntry: 9090,
    post: async () => {
      posts += 1;
      throw sapError('-1029', 'Record is being modified by another user');
    },
    verify: async () => null,
    onParked: () => {},
  });

  const record = await state.getRecord(companyKey, 7006, 9090);
  await state.markRetrying(companyKey, 7006, 9090, {
    attempts: record.attempts,
    nextAttemptAt: null,
    classification: record.classification,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
  });

  const result = await postDraftGuarded({
    companyKey,
    approvalRequestId: 7006,
    draftEntry: 9090,
    post: async () => {
      posts += 1;
      return { DocEntry: 1 };
    },
    verify: async () => {
      throw new Error('Service Layer unreachable');
    },
    onParked: () => {},
  });

  assert.equal(result.reason, 'verify_failed');
  assert.equal(posts, 1, 'without confirmation we wait rather than risk a burn');
});

test('a successful post is recorded and never repeated', async () => {
  const companyKey = freshCompany();
  let posts = 0;

  const first = await postDraftGuarded({
    companyKey,
    approvalRequestId: 7007,
    draftEntry: 1212,
    post: async () => {
      posts += 1;
      return { DocEntry: 55555, DocNum: 1234 };
    },
    verify: async () => null,
  });
  assert.equal(first.outcome, 'posted');
  assert.equal(first.docEntry, 55555);

  for (let i = 0; i < 10; i += 1) {
    const again = await postDraftGuarded({
      companyKey,
      approvalRequestId: 7007,
      draftEntry: 1212,
      post: async () => {
        posts += 1;
        return { DocEntry: 66666 };
      },
      verify: async () => null,
    });
    assert.equal(again.reason, 'already_posted');
  }
  assert.equal(posts, 1);
});

// --- the way back in ------------------------------------------------------

test('the retry link un-parks a draft, and verification still runs afterwards', async () => {
  const companyKey = freshCompany();
  let posts = 0;

  await postDraftGuarded({
    companyKey,
    approvalRequestId: 7008,
    draftEntry: 1313,
    post: async () => {
      posts += 1;
      throw sapError('-5002', 'Out of stock');
    },
    verify: async () => null,
    onParked: () => {},
  });
  assert.equal(posts, 1);

  const cleared = await state.clearPark(companyKey, 7008, 1313);
  assert.ok(cleared, 'the park should be clearable by the retry link');
  assert.equal(cleared.everAttempted, true, 'history must survive so verify still runs');

  // Someone posted it by hand in SAP in the meantime — must not duplicate it.
  const result = await postDraftGuarded({
    companyKey,
    approvalRequestId: 7008,
    draftEntry: 1313,
    post: async () => {
      posts += 1;
      return { DocEntry: 1 };
    },
    verify: async () => 123123,
    onParked: () => {},
  });

  assert.equal(result.reason, 'already_converted');
  assert.equal(posts, 1);
});

test('clearPark does nothing for a draft that is not parked', async () => {
  const companyKey = freshCompany();
  assert.equal(await state.clearPark(companyKey, 9999, 9999), null);
});

test('a retry token round-trips and is bound to its own purpose', () => {
  const token = signDraftRetryToken({ approvalRequestId: 4321, draftEntry: 8765 });
  const verdict = verifyDraftRetryToken(token);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.approvalRequestId, '4321');
  assert.equal(verdict.draftEntry, '8765');

  assert.equal(verifyDraftRetryToken('not-a-token').valid, false);
  assert.equal(verifyDraftRetryToken(token, { secret: 'a-different-secret' }).valid, false);
});

test.after(async () => {
  await fs.rm(STATE_DIR, { recursive: true, force: true }).catch(() => {});
});
