import test from 'node:test';
import assert from 'node:assert/strict';
import { signDigestToken, verifyDigestToken } from '../src/utils/digestToken.js';

const SECRET = 'unit-test-secret';

test('a signed digest token round-trips to the approver user id', () => {
  const token = signDigestToken({ sapUserId: 42 }, { secret: SECRET, expiresIn: '1h' });
  const result = verifyDigestToken(token, { secret: SECRET });
  assert.equal(result.valid, true);
  assert.equal(result.sapUserId, '42');
  assert.equal(result.expired, false);
});

test('an expired token is reported invalid and expired', () => {
  const token = signDigestToken({ sapUserId: 7 }, { secret: SECRET, expiresIn: -10 });
  const result = verifyDigestToken(token, { secret: SECRET });
  assert.equal(result.valid, false);
  assert.equal(result.expired, true);
  assert.equal(result.sapUserId, null);
});

test('a token signed with a different secret is rejected (tamper/forgery)', () => {
  const token = signDigestToken({ sapUserId: 42 }, { secret: SECRET, expiresIn: '1h' });
  const result = verifyDigestToken(token, { secret: 'other-secret' });
  assert.equal(result.valid, false);
  assert.equal(result.sapUserId, null);
});

test('a garbage token is rejected without throwing', () => {
  const result = verifyDigestToken('not-a-jwt', { secret: SECRET });
  assert.equal(result.valid, false);
  assert.equal(result.sapUserId, null);
});

test('a token for one purpose is not accepted for another (audience is pinned)', () => {
  // A generic HS512 token without the digest audience must not pass verification.
  const token = signDigestToken({ sapUserId: 42 }, { secret: SECRET, expiresIn: '1h', audience: 'some-other-audience' });
  const result = verifyDigestToken(token, { secret: SECRET });
  assert.equal(result.valid, false);
});
