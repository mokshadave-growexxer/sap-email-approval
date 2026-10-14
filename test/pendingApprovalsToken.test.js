import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  signPendingApprovalsToken,
  verifyPendingApprovalsToken,
  PENDING_APPROVALS_LINK_TTL,
} from '../src/utils/pendingApprovalsToken.js';
import { signDigestToken, verifyDigestToken } from '../src/utils/digestToken.js';

const SECRET = 'test-secret';

test('a pending approvals token round-trips its process id', () => {
  const token = signPendingApprovalsToken({ processId: 'abc-123' }, { secret: SECRET });
  const verified = verifyPendingApprovalsToken(token, { secret: SECRET });
  assert.deepEqual({ ...verified }, { valid: true, processId: 'abc-123', expired: false });
});

test('pending approvals links are valid for exactly 10 days', () => {
  assert.equal(PENDING_APPROVALS_LINK_TTL, '10d');
  const token = signPendingApprovalsToken({ processId: 'p' }, { secret: SECRET });
  const { iat, exp } = jwt.decode(token);
  assert.equal(exp - iat, 10 * 24 * 60 * 60);
});

test('an expired pending approvals token is reported as expired', () => {
  const token = signPendingApprovalsToken({ processId: 'p' }, { secret: SECRET, expiresIn: -1 });
  const verified = verifyPendingApprovalsToken(token, { secret: SECRET });
  assert.equal(verified.valid, false);
  assert.equal(verified.expired, true);
});

test('a forged or tampered pending approvals token is rejected', () => {
  const token = signPendingApprovalsToken({ processId: 'p' }, { secret: 'other-secret' });
  assert.equal(verifyPendingApprovalsToken(token, { secret: SECRET }).valid, false);
  assert.equal(verifyPendingApprovalsToken('not-a-token', { secret: SECRET }).valid, false);
});

test('digest and pending approvals tokens are not interchangeable', () => {
  const digest = signDigestToken({ sapUserId: 83 }, { secret: SECRET, expiresIn: '1h' });
  assert.equal(verifyPendingApprovalsToken(digest, { secret: SECRET }).valid, false);
  const pending = signPendingApprovalsToken({ processId: 'p' }, { secret: SECRET });
  assert.equal(verifyDigestToken(pending, { secret: SECRET }).valid, false);
});
