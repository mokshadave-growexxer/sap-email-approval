import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalService,
  ApprovalStageAdvancedError,
  LINE_STATUS,
  REQUEST_STATUS,
  STATUS,
} from '../src/services/sap/approvalService.js';

// A request whose stage 1 has already been decided elsewhere (the SAP add-on),
// so it now waits on stage 2 with the SAME approver still pending there.
function requestAdvancedToStageTwo({ userId = 42 } = {}) {
  return {
    Code: 1001,
    Status: REQUEST_STATUS.PENDING,
    CurrentStage: 2,
    ObjectType: '17',
    IsDraft: 'Y',
    DraftEntry: 55,
    ObjectEntry: null,
    ApprovalRequestLines: [
      { UserID: userId, StageCode: 1, Status: LINE_STATUS.APPROVED },
      { UserID: userId, StageCode: 2, Status: LINE_STATUS.PENDING },
    ],
  };
}

function pendingStageOneRequest({ userId = 42 } = {}) {
  return {
    Code: 1001,
    Status: REQUEST_STATUS.PENDING,
    CurrentStage: 1,
    ObjectType: '17',
    IsDraft: 'Y',
    DraftEntry: 55,
    ObjectEntry: null,
    ApprovalRequestLines: [{ UserID: userId, StageCode: 1, Status: LINE_STATUS.PENDING }],
  };
}

function createSessionManager({ before, after }) {
  const calls = { get: [], patch: [], post: [] };
  const sessionManager = {
    async ensureLoggedIn() {},
    async login() {},
    async logout() {},
    client: {
      async get(url) {
        calls.get.push(url);
        return { data: calls.get.length === 1 ? before : after };
      },
      async patch(url, body) {
        calls.patch.push({ url, body });
        return { status: 204, data: null };
      },
      async post(url, body) {
        calls.post.push({ url, body });
        return { status: 200, data: { DocEntry: 9001, DocNum: 501 } };
      },
    },
  };
  return { sessionManager, calls };
}

test('decide refuses and never patches when the target stage has already advanced', async () => {
  const before = requestAdvancedToStageTwo();
  const { sessionManager, calls } = createSessionManager({ before, after: before });
  const service = new ApprovalService(sessionManager);

  await assert.rejects(
    () =>
      service.approveRequest({
        approvalRequestId: 1001,
        approverUserId: 42,
        approverUsername: 'manager',
        approverPassword: 'secret-password',
        expectedStage: 1,
      }),
    ApprovalStageAdvancedError
  );
  assert.equal(calls.patch.length, 0);
});

test('decide refuses when the approver line at the target stage is no longer pending', async () => {
  const before = {
    Code: 1001,
    Status: REQUEST_STATUS.PENDING,
    CurrentStage: 1,
    ObjectType: '17',
    IsDraft: 'Y',
    DraftEntry: 55,
    ApprovalRequestLines: [{ UserID: 42, StageCode: 1, Status: LINE_STATUS.APPROVED }],
  };
  const { sessionManager, calls } = createSessionManager({ before, after: before });
  const service = new ApprovalService(sessionManager);

  await assert.rejects(
    () =>
      service.approveRequest({
        approvalRequestId: 1001,
        approverUserId: 42,
        approverUsername: 'manager',
        approverPassword: 'secret-password',
        expectedStage: 1,
      }),
    ApprovalStageAdvancedError
  );
  assert.equal(calls.patch.length, 0);
});

test('decide proceeds when the target stage is still the current, pending stage', async () => {
  const before = pendingStageOneRequest();
  const after = {
    ...before,
    Status: REQUEST_STATUS.APPROVED,
    ApprovalRequestLines: [{ UserID: 42, StageCode: 1, Status: STATUS.APPROVE }],
  };
  const { sessionManager, calls } = createSessionManager({ before, after });
  const service = new ApprovalService(sessionManager);

  const result = await service.approveRequest({
    approvalRequestId: 1001,
    approverUserId: 42,
    approverUsername: 'manager',
    approverPassword: 'secret-password',
    expectedStage: 1,
  });

  assert.equal(result.success, true);
  assert.equal(calls.patch.length, 1);
});

test('decide verifies a non-final stage approval even after SAP advances CurrentStage', async () => {
  const before = {
    Code: 1001,
    Status: REQUEST_STATUS.PENDING,
    CurrentStage: 1,
    ObjectType: '17',
    IsDraft: 'Y',
    DraftEntry: 55,
    ApprovalRequestLines: [
      { UserID: 42, StageCode: 1, Status: LINE_STATUS.PENDING },
      { UserID: 42, StageCode: 2, Status: LINE_STATUS.PENDING },
    ],
  };
  const after = {
    ...before,
    CurrentStage: 2,
    ApprovalRequestLines: [
      { UserID: 42, StageCode: 1, Status: STATUS.APPROVE },
      { UserID: 42, StageCode: 2, Status: LINE_STATUS.PENDING },
    ],
  };
  const { sessionManager, calls } = createSessionManager({ before, after });
  const service = new ApprovalService(sessionManager);

  const result = await service.approveRequest({
    approvalRequestId: 1001,
    approverUserId: 42,
    approverUsername: 'manager',
    approverPassword: 'secret-password',
    expectedStage: 1,
  });

  assert.equal(result.success, true);
  assert.equal(result.currentStatus, REQUEST_STATUS.PENDING);
  assert.equal(result.draftPost, null);
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.post.length, 0);
});

test('getDecisionEligibility reports stage_advanced for a superseded stage', async () => {
  const before = requestAdvancedToStageTwo();
  const { sessionManager, calls } = createSessionManager({ before, after: before });
  const service = new ApprovalService(sessionManager);

  const eligibility = await service.getDecisionEligibility({
    approvalRequestId: 1001,
    approverUserId: 42,
    stage: 1,
  });

  assert.equal(eligibility.actionable, false);
  assert.equal(eligibility.reason, 'stage_advanced');
  assert.equal(calls.patch.length, 0);
});

test('getDecisionEligibility reports request_not_pending once fully decided', async () => {
  const before = {
    Code: 1001,
    Status: REQUEST_STATUS.APPROVED,
    CurrentStage: 1,
    ApprovalRequestLines: [{ UserID: 42, StageCode: 1, Status: LINE_STATUS.APPROVED }],
  };
  const { sessionManager } = createSessionManager({ before, after: before });
  const service = new ApprovalService(sessionManager);

  const eligibility = await service.getDecisionEligibility({
    approvalRequestId: 1001,
    approverUserId: 42,
    stage: 1,
  });

  assert.equal(eligibility.actionable, false);
  assert.equal(eligibility.reason, 'request_not_pending');
});

test('getDecisionEligibility is actionable for the current pending stage', async () => {
  const before = pendingStageOneRequest();
  const { sessionManager } = createSessionManager({ before, after: before });
  const service = new ApprovalService(sessionManager);

  const eligibility = await service.getDecisionEligibility({
    approvalRequestId: 1001,
    approverUserId: 42,
    stage: 1,
  });

  assert.equal(eligibility.actionable, true);
  assert.equal(eligibility.reason, 'ok');
});
