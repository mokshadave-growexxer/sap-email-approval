import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalService,
  ApprovalDocumentLockedError,
  ApprovalStageAdvancedError,
  DECISION_ELIGIBILITY,
  LINE_STATUS,
  REQUEST_STATUS,
} from '../src/services/sap/approvalService.js';

// SAP returns 404 for a WddCode that was deleted when the originator edited the
// pending draft (confirmed live: edit hard-deletes the request and mints a new one).
function notFoundError() {
  const e = new Error('Not Found');
  e.response = { status: 404, data: { error: { code: -2028, message: { value: 'No matching records found' } } } };
  return e;
}

function lockError() {
  const e = new Error('locked');
  e.response = {
    status: 500,
    data: { error: { code: -1029, message: { value: 'This record is being used by another user (ODRF)' } } },
  };
  return e;
}

function pendingRequest({ userId = 42, stage = 1 } = {}) {
  return {
    Code: 1001,
    Status: REQUEST_STATUS.PENDING,
    CurrentStage: stage,
    ObjectType: '17',
    IsDraft: 'Y',
    DraftEntry: 55,
    ApprovalRequestLines: [{ UserID: userId, StageCode: stage, Status: LINE_STATUS.PENDING }],
  };
}

function sessionManager({ getImpl, patchImpl }) {
  const calls = { get: 0, patch: 0 };
  return {
    calls,
    mgr: {
      async ensureLoggedIn() {},
      async login() {},
      async logout() {},
      client: {
        async get(url) {
          calls.get += 1;
          return getImpl(url, calls.get);
        },
        async patch(url, body) {
          calls.patch += 1;
          return patchImpl ? patchImpl(url, body, calls.patch) : { status: 204, data: null };
        },
        async post() {
          return { status: 200, data: {} };
        },
      },
    },
  };
}

test('getDecisionEligibility reports request_not_found when the WddCode was deleted by an edit', async () => {
  const { mgr } = sessionManager({ getImpl: () => Promise.reject(notFoundError()) });
  const service = new ApprovalService(mgr);

  const eligibility = await service.getDecisionEligibility({ approvalRequestId: 1001, approverUserId: 42, stage: 1 });

  assert.equal(eligibility.actionable, false);
  assert.equal(eligibility.reason, DECISION_ELIGIBILITY.REQUEST_NOT_FOUND);
});

test('decide refuses and never patches when the request was deleted by an edit (404)', async () => {
  const { mgr, calls } = sessionManager({ getImpl: () => Promise.reject(notFoundError()) });
  const service = new ApprovalService(mgr);

  await assert.rejects(
    () =>
      service.approveRequest({
        approvalRequestId: 1001,
        approverUserId: 42,
        approverUsername: 'manager',
        approverPassword: 'secret',
        expectedStage: 1,
      }),
    (err) => err instanceof ApprovalStageAdvancedError && err.meta?.reason === DECISION_ELIGIBILITY.REQUEST_NOT_FOUND
  );
  assert.equal(calls.patch, 0);
});

test('decide surfaces a document-locked error when SAP reports the record is in use', async () => {
  const { mgr } = sessionManager({
    getImpl: () => Promise.resolve({ data: pendingRequest() }),
    patchImpl: () => Promise.reject(lockError()),
  });
  const service = new ApprovalService(mgr);

  await assert.rejects(
    () =>
      service.approveRequest({
        approvalRequestId: 1001,
        approverUserId: 42,
        approverUsername: 'manager',
        approverPassword: 'secret',
        expectedStage: 1,
      }),
    ApprovalDocumentLockedError
  );
});
