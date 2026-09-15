import test from 'node:test';
import assert from 'node:assert/strict';
import { runBulkDecision, BULK_RESULT } from '../src/services/digest/bulkDecisionService.js';
import { DECISION_OUTCOME } from '../src/services/approval/decisionExecutor.js';
import { ApprovalInvalidCredentialsError } from '../src/services/sap/approvalService.js';

const gateSession = { session_id: 'gate-1', timezone: 'Asia/Kolkata' };
const silent = { info() {}, warn() {}, error() {} };

function processFor(id, { owner = 42, status = 'pending' } = {}) {
  return { id, approval_request_id: `req-${id}`, sap_user_id: owner, status, draft_entry: 5, user_code: 'manager' };
}

function makeDeps({ processes, decide }) {
  const materialized = [];
  return {
    materialized,
    deps: {
      getProcess: async (id) => processes[id] ?? null,
      materializePerProcessFootprint: async ({ processId }) => {
        materialized.push(processId);
        return { session_id: `fp-${processId}`, timezone: 'Asia/Kolkata' };
      },
      executeDecision: decide,
      logger: silent,
    },
  };
}

test('a mixed batch is aggregated per outcome and only approves count as success', async () => {
  const processes = {
    a: processFor('a'),
    b: processFor('b'),
    c: processFor('c'),
  };
  const decide = async ({ process }) => {
    if (process.id === 'a') return { outcome: DECISION_OUTCOME.SUCCESS };
    if (process.id === 'b') return { outcome: DECISION_OUTCOME.SUPERSEDED };
    return { outcome: DECISION_OUTCOME.LOCKED };
  };
  const { deps, materialized } = makeDeps({ processes, decide });

  const result = await runBulkDecision(
    { sapUserId: 42, action: 'approve', selected: ['a', 'b', 'c'], effectivePassword: 'pw', remarks: '', gateSession },
    deps
  );

  assert.equal(result.counts[BULK_RESULT.APPROVED], 1);
  assert.equal(result.counts[BULK_RESULT.SUPERSEDED], 1);
  assert.equal(result.counts[BULK_RESULT.LOCKED], 1);
  assert.equal(result.anySuccess, true);
  assert.equal(result.credentialRejected, false);
  assert.deepEqual(materialized, ['a', 'b', 'c']);
});

test('reject decisions count under rejected', async () => {
  const processes = { a: processFor('a') };
  const { deps } = makeDeps({ processes, decide: async () => ({ outcome: DECISION_OUTCOME.SUCCESS }) });
  const result = await runBulkDecision(
    { sapUserId: 42, action: 'reject', selected: ['a'], effectivePassword: 'pw', gateSession },
    deps
  );
  assert.equal(result.counts[BULK_RESULT.REJECTED], 1);
  assert.equal(result.counts[BULK_RESULT.APPROVED], 0);
});

test('a process owned by a different approver is never acted on', async () => {
  const processes = { a: processFor('a', { owner: 999 }) };
  let decided = false;
  const { deps, materialized } = makeDeps({
    processes,
    decide: async () => {
      decided = true;
      return { outcome: DECISION_OUTCOME.SUCCESS };
    },
  });
  const result = await runBulkDecision(
    { sapUserId: 42, action: 'approve', selected: ['a'], effectivePassword: 'pw', gateSession },
    deps
  );
  assert.equal(result.counts[BULK_RESULT.NOT_ACTIONABLE], 1);
  assert.equal(decided, false);
  assert.deepEqual(materialized, []); // no footprint materialized for a non-actionable SO
});

test('an already-decided (non-pending) process is reported, not re-decided', async () => {
  const processes = { a: processFor('a', { status: 'approved' }) };
  let decided = false;
  const { deps } = makeDeps({
    processes,
    decide: async () => {
      decided = true;
      return { outcome: DECISION_OUTCOME.SUCCESS };
    },
  });
  const result = await runBulkDecision(
    { sapUserId: 42, action: 'approve', selected: ['a'], effectivePassword: 'pw', gateSession },
    deps
  );
  assert.equal(result.counts[BULK_RESULT.ALREADY_DECIDED], 1);
  assert.equal(decided, false);
});

test('a rejected password aborts the batch on the first item with nothing decided', async () => {
  const processes = { a: processFor('a'), b: processFor('b') };
  const attempts = [];
  const decide = async ({ process }) => {
    attempts.push(process.id);
    throw new ApprovalInvalidCredentialsError('req', 'manager');
  };
  const { deps } = makeDeps({ processes, decide });

  const result = await runBulkDecision(
    { sapUserId: 42, action: 'approve', selected: ['a', 'b'], effectivePassword: 'wrong', gateSession },
    deps
  );

  assert.equal(result.credentialRejected, true);
  assert.equal(result.anySuccess, false);
  assert.deepEqual(attempts, ['a']); // stopped after the first item; 'b' never attempted
  assert.equal(result.counts[BULK_RESULT.APPROVED], 0);
});

test('a claim failure is reported as already decided', async () => {
  const processes = { a: processFor('a') };
  const { deps } = makeDeps({ processes, decide: async () => ({ outcome: DECISION_OUTCOME.CLAIM_FAILED }) });
  const result = await runBulkDecision(
    { sapUserId: 42, action: 'approve', selected: ['a'], effectivePassword: 'pw', gateSession },
    deps
  );
  assert.equal(result.counts[BULK_RESULT.ALREADY_DECIDED], 1);
});

test('a generic failure is reported as failed', async () => {
  const processes = { a: processFor('a') };
  const { deps } = makeDeps({ processes, decide: async () => ({ outcome: DECISION_OUTCOME.FAILED }) });
  const result = await runBulkDecision(
    { sapUserId: 42, action: 'approve', selected: ['a'], effectivePassword: 'pw', gateSession },
    deps
  );
  assert.equal(result.counts[BULK_RESULT.FAILED], 1);
});
