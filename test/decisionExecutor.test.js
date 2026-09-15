import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDecision, DECISION_OUTCOME } from '../src/services/approval/decisionExecutor.js';
import {
  ApprovalDocumentLockedError,
  ApprovalInvalidCredentialsError,
  ApprovalStageAdvancedError,
  ApprovalSapError,
} from '../src/services/sap/approvalService.js';

function baseProcess() {
  return {
    id: 'proc-1',
    approval_request_id: '1001',
    stage: 1,
    sap_user_id: 42,
    user_code: 'manager',
    approver_email: 'a@x.com',
    draft_entry: 55,
  };
}

function footprintSession() {
  return { session_id: 'fp-1', timezone: 'Asia/Kolkata', ip_address: '10.0.0.1' };
}

function makeDeps(overrides = {}) {
  const calls = {
    claim: [],
    release: [],
    decided: [],
    superseded: [],
    pending: [],
    success: [],
    failed: [],
    remark: [],
    link: [],
    reconcile: [],
  };
  const deps = {
    claimProcess: async (id) => {
      calls.claim.push(id);
      return { ok: true, process: baseProcess() };
    },
    releaseProcess: async (id) => calls.release.push(id),
    markProcessDecided: async (id, action) => calls.decided.push({ id, action }),
    markProcessSuperseded: async (id, reason) => calls.superseded.push({ id, reason }),
    createPendingDecision: async (arg) => {
      calls.pending.push(arg);
      return { id: arg.processId };
    },
    markDecisionSuccess: async (id, data) => calls.success.push({ id, data }),
    markDecisionFailed: async (id, reason) => calls.failed.push({ id, reason }),
    writeDecisionRemark: async (arg) => calls.remark.push(arg),
    linkApprovalFootprintsToDocument: async (arg) => calls.link.push(arg),
    scheduleFinalDocReconciliation: (arg) => calls.reconcile.push(arg),
    getSalesOrderChangeStatus: () => ({ code: 'CREATED', label: 'New Sales Order' }),
    currentCompany: () => ({ key: 'millp' }),
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
  return { deps, calls };
}

function approvalServiceStub(impl) {
  return { approveRequest: impl, rejectRequest: impl };
}

test('a successful final approval decides, records, and links the footprint to the document', async () => {
  const { deps, calls } = makeDeps({
    approvalService: approvalServiceStub(async () => ({
      approvalRequestId: '1001',
      currentStatus: 'arsApproved',
      draftPost: { attempted: true, success: true, result: { DocEntry: 900 } },
      sapResponse: { before: {}, after: { IsDraft: 'N', ObjectEntry: 900 } },
    })),
  });

  const outcome = await executeDecision(
    { process: baseProcess(), action: 'approve', effectivePassword: 'pw', remarks: 'ok', footprintSession: footprintSession() },
    deps
  );

  assert.equal(outcome.outcome, DECISION_OUTCOME.SUCCESS);
  assert.equal(outcome.currentStatus, 'arsApproved');
  assert.deepEqual(calls.decided, [{ id: 'proc-1', action: 'approve' }]);
  assert.equal(calls.success.length, 1);
  assert.equal(calls.remark.length, 1); // remark provided
  assert.equal(calls.link.length, 1);
  assert.equal(calls.link[0].docEntry, 900);
  assert.equal(calls.reconcile.length, 0);
});

test('a non-final approval succeeds without posting or linking a document', async () => {
  const { deps, calls } = makeDeps({
    approvalService: approvalServiceStub(async () => ({
      approvalRequestId: '1001',
      currentStatus: 'arsPending', // advanced to next stage, not fully approved
      draftPost: null,
      sapResponse: { before: {}, after: { Status: 'arsPending' } },
    })),
  });

  const outcome = await executeDecision(
    { process: baseProcess(), action: 'approve', effectivePassword: 'pw', remarks: '', footprintSession: footprintSession() },
    deps
  );

  assert.equal(outcome.outcome, DECISION_OUTCOME.SUCCESS);
  assert.equal(calls.link.length, 0);
  assert.equal(calls.reconcile.length, 0);
  assert.equal(calls.remark.length, 0); // no remark
});

test('a claim that fails short-circuits before any SAP decision', async () => {
  let decided = false;
  const { deps } = makeDeps({
    claimProcess: async () => ({ ok: false, reason: 'approval already decided' }),
    approvalService: approvalServiceStub(async () => {
      decided = true;
      return {};
    }),
  });

  const outcome = await executeDecision(
    { process: baseProcess(), action: 'approve', effectivePassword: 'pw', footprintSession: footprintSession() },
    deps
  );

  assert.equal(outcome.outcome, DECISION_OUTCOME.CLAIM_FAILED);
  assert.equal(decided, false);
});

test('a document lock releases the process and reports locked', async () => {
  const { deps, calls } = makeDeps({
    approvalService: approvalServiceStub(async () => {
      throw new ApprovalDocumentLockedError('1001');
    }),
  });

  const outcome = await executeDecision(
    { process: baseProcess(), action: 'approve', effectivePassword: 'pw', footprintSession: footprintSession() },
    deps
  );

  assert.equal(outcome.outcome, DECISION_OUTCOME.LOCKED);
  assert.deepEqual(calls.release, ['proc-1']);
});

test('a stage already decided in SAP supersedes the link', async () => {
  const { deps, calls } = makeDeps({
    approvalService: approvalServiceStub(async () => {
      throw new ApprovalStageAdvancedError('1001', 1, 'stage_advanced');
    }),
  });

  const outcome = await executeDecision(
    { process: baseProcess(), action: 'approve', effectivePassword: 'pw', footprintSession: footprintSession() },
    deps
  );

  assert.equal(outcome.outcome, DECISION_OUTCOME.SUPERSEDED);
  assert.equal(calls.superseded.length, 1);
});

test('invalid credentials release the process and propagate (so callers can re-prompt)', async () => {
  const { deps, calls } = makeDeps({
    approvalService: approvalServiceStub(async () => {
      throw new ApprovalInvalidCredentialsError('1001', 'manager');
    }),
  });

  await assert.rejects(
    () =>
      executeDecision(
        { process: baseProcess(), action: 'approve', effectivePassword: 'wrong', footprintSession: footprintSession() },
        deps
      ),
    ApprovalInvalidCredentialsError
  );
  assert.deepEqual(calls.release, ['proc-1']);
});

test('a generic SAP error releases and reports failed (never fakes success)', async () => {
  const { deps, calls } = makeDeps({
    approvalService: approvalServiceStub(async () => {
      throw new ApprovalSapError('boom', {});
    }),
  });

  const outcome = await executeDecision(
    { process: baseProcess(), action: 'reject', effectivePassword: 'pw', footprintSession: footprintSession() },
    deps
  );

  assert.equal(outcome.outcome, DECISION_OUTCOME.FAILED);
  assert.deepEqual(calls.release, ['proc-1']);
});
