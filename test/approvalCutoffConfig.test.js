import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMinRequestId } from '../src/config/index.js';

test('resolveMinRequestId reads the per-company env override (uppercased key)', () => {
  const env = { APPROVAL_MIN_REQUEST_ID_MILLP: '130866', APPROVAL_MIN_REQUEST_ID_MSPL: '42' };
  assert.equal(resolveMinRequestId('millp', env), 130866);
  assert.equal(resolveMinRequestId('mspl', env), 42);
});

test('resolveMinRequestId returns null when unset or non-numeric (worker will self-baseline)', () => {
  assert.equal(resolveMinRequestId('millp', {}), null);
  assert.equal(resolveMinRequestId('millp', { APPROVAL_MIN_REQUEST_ID_MILLP: '' }), null);
  assert.equal(resolveMinRequestId('millp', { APPROVAL_MIN_REQUEST_ID_MILLP: 'abc' }), null);
});
