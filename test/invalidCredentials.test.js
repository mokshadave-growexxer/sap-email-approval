import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalService,
  ApprovalInvalidCredentialsError,
  ApprovalSapError,
  LINE_STATUS,
  REQUEST_STATUS,
} from '../src/services/sap/approvalService.js';

function pendingRequest() {
  return {
    Code: 1001,
    Status: REQUEST_STATUS.PENDING,
    CurrentStage: 1,
    ObjectType: '17',
    IsDraft: 'Y',
    DraftEntry: 55,
    ApprovalRequestLines: [{ UserID: 42, StageCode: 1, Status: LINE_STATUS.PENDING }],
  };
}

function badPasswordError() {
  const e = new Error('bad password');
  e.response = {
    status: 400,
    data: { error: { code: '-8023', message: { value: 'User code or password is incorrect' } } },
  };
  return e;
}

function genericSapError() {
  const e = new Error('boom');
  e.response = { status: 400, data: { error: { code: '-5002', message: { value: 'Cannot add row' } } } };
  return e;
}

function sessionManager(patchImpl) {
  return {
    async ensureLoggedIn() {},
    async login() {},
    async logout() {},
    client: {
      async get() {
        return { data: pendingRequest() };
      },
      async patch() {
        return patchImpl();
      },
      async post() {
        return { status: 200, data: {} };
      },
    },
  };
}

test('a wrong SAP password surfaces ApprovalInvalidCredentialsError', async () => {
  const service = new ApprovalService(sessionManager(() => Promise.reject(badPasswordError())));
  await assert.rejects(
    () =>
      service.approveRequest({
        approvalRequestId: 1001,
        approverUserId: 42,
        approverUsername: 'manager',
        approverPassword: 'wrong',
        expectedStage: 1,
      }),
    ApprovalInvalidCredentialsError
  );
});

test('a non-credential SAP failure stays an ApprovalSapError (not a credential prompt)', async () => {
  const service = new ApprovalService(sessionManager(() => Promise.reject(genericSapError())));
  await assert.rejects(
    () =>
      service.approveRequest({
        approvalRequestId: 1001,
        approverUserId: 42,
        approverUsername: 'manager',
        approverPassword: 'secret',
        expectedStage: 1,
      }),
    (err) => err instanceof ApprovalSapError && !(err instanceof ApprovalInvalidCredentialsError)
  );
});
