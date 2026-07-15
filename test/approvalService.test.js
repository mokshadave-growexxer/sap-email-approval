import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalService,
  STATUS,
  redactApprovalDecisionBodyForLog,
} from '../src/services/sap/approvalService.js';

function createPendingRequest({
  code = 1001,
  userId = 42,
  stage = 1,
  objectType = '17',
  isDraft = 'Y',
  draftEntry = 55,
} = {}) {
  return {
    Code: code,
    Status: 'arsPending',
    CurrentStage: stage,
    ObjectType: objectType,
    IsDraft: isDraft,
    DraftEntry: draftEntry,
    ObjectEntry: null,
    ApprovalRequestLines: [{ UserID: userId, StageCode: stage, Status: 'ardPending' }],
  };
}

function createApprovedAfter({
  code = 1001,
  userId = 42,
  stage = 1,
  objectType = '17',
  isDraft = 'Y',
  draftEntry = 55,
  lineStatus = STATUS.APPROVE,
  overallStatus = 'arsApproved',
} = {}) {
  return {
    Code: code,
    Status: overallStatus,
    CurrentStage: stage,
    ObjectType: objectType,
    IsDraft: isDraft,
    DraftEntry: draftEntry,
    ObjectEntry: null,
    ApprovalRequestLines: [{ UserID: userId, StageCode: stage, Status: lineStatus }],
  };
}

function createSessionManager({ before, after, postImpl }) {
  const calls = {
    get: [],
    patch: [],
    post: [],
  };

  const sessionManager = {
    async ensureLoggedIn() {
      return { ok: true };
    },
    async login() {},
    async logout() {},
    client: {
      async get(url) {
        calls.get.push(url);
        if (calls.get.length === 1) {
          return { data: before };
        }
        return { data: after };
      },
      async patch(url, body) {
        calls.patch.push({ url, body });
        return { status: 204, data: null };
      },
      async post(url, body) {
        calls.post.push({ url, body });
        if (typeof postImpl === 'function') {
          return postImpl(url, body);
        }
        return { status: 200, data: { DocEntry: 9001, DocNum: 501 } };
      },
    },
  };

  return { sessionManager, calls };
}

const AFTER_SELECT =
  '$select=Status,CurrentStage,ObjectType,IsDraft,DraftEntry,ObjectEntry,ApprovalRequestLines';

test('decide posts draft when verified arsApproved + ObjectType 17 + IsDraft Y', async () => {
  const before = createPendingRequest();
  const after = createApprovedAfter();
  const { sessionManager, calls } = createSessionManager({ before, after });
  const service = new ApprovalService(sessionManager);

  const result = await service.approveRequest({
    approvalRequestId: 1001,
    approverUserId: 42,
    approverUsername: 'manager',
    approverPassword: 'secret-password',
    remarks: 'ok',
  });

  assert.equal(result.success, true);
  assert.equal(result.currentStatus, 'arsApproved');
  assert.equal(result.draftPost?.attempted, true);
  assert.equal(result.draftPost?.success, true);
  assert.equal(result.draftPost?.draftEntry, '55');
  assert.equal(result.draftPost?.result?.DocEntry, 9001);

  assert.equal(calls.get.length, 2);
  assert.ok(String(calls.get[1]).includes(AFTER_SELECT));
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].url, '/DraftsService_SaveDraftToDocument');
  assert.deepEqual(calls.post[0].body, { Document: { DocEntry: '55' } });
  assert.equal(calls.patch[0].body.ApprovalRequestDecisions[0].ApproverPassword, 'secret-password');
});

test('decide does not post for other ObjectTypes or IsDraft N', async () => {
  for (const afterOverrides of [
    { objectType: '22', isDraft: 'Y' },
    { objectType: '17', isDraft: 'N' },
  ]) {
    const before = createPendingRequest(afterOverrides);
    const after = createApprovedAfter(afterOverrides);
    const { sessionManager, calls } = createSessionManager({ before, after });
    const service = new ApprovalService(sessionManager);

    const result = await service.approveRequest({
      approvalRequestId: 1001,
      approverUserId: 42,
      approverUsername: 'manager',
      approverPassword: 'secret-password',
    });

    assert.equal(result.success, true);
    assert.equal(result.draftPost, null);
    assert.equal(calls.post.length, 0);
  }
});

test('SaveDraftToDocument failure does not undo approval decision', async () => {
  const before = createPendingRequest();
  const after = createApprovedAfter();
  const { sessionManager, calls } = createSessionManager({
    before,
    after,
    postImpl: async () => {
      const error = new Error('SAP draft post failed');
      error.response = {
        status: 400,
        data: { error: { message: { value: 'Cannot post draft' }, code: '-5002' } },
      };
      throw error;
    },
  });
  const service = new ApprovalService(sessionManager);

  const result = await service.approveRequest({
    approvalRequestId: 1001,
    approverUserId: 42,
    approverUsername: 'manager',
    approverPassword: 'secret-password',
  });

  assert.equal(result.success, true);
  assert.equal(result.currentStatus, 'arsApproved');
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.post.length, 1);
  assert.equal(result.draftPost?.attempted, true);
  assert.equal(result.draftPost?.success, false);
  assert.match(result.draftPost?.error || '', /posting the draft failed/i);
  assert.match(result.draftPost?.error || '', /manual or automatic retry/i);
});

test('redactApprovalDecisionBodyForLog masks ApproverPassword', () => {
  const body = {
    ApprovalRequestDecisions: [
      {
        Status: STATUS.APPROVE,
        ApproverUserName: 'manager',
        ApproverPassword: 'secret-password',
        Remarks: 'ok',
      },
    ],
  };

  const redacted = redactApprovalDecisionBodyForLog(body);

  assert.equal(redacted.ApprovalRequestDecisions[0].ApproverPassword, '***');
  assert.equal(body.ApprovalRequestDecisions[0].ApproverPassword, 'secret-password');
  assert.equal(redacted.ApprovalRequestDecisions[0].ApproverUserName, 'manager');
});

test('decide does not post when overall status is still arsPending after line approve', async () => {
  const before = createPendingRequest();
  const after = createApprovedAfter({ overallStatus: 'arsPending' });
  const { sessionManager, calls } = createSessionManager({ before, after });
  const service = new ApprovalService(sessionManager);

  const result = await service.approveRequest({
    approvalRequestId: 1001,
    approverUserId: 42,
    approverUsername: 'manager',
    approverPassword: 'secret-password',
  });

  assert.equal(result.success, true);
  assert.equal(result.currentStatus, 'arsPending');
  assert.equal(result.draftPost, null);
  assert.equal(calls.post.length, 0);
});
