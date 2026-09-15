import test from 'node:test';
import assert from 'node:assert/strict';
import { config, parseDigestAllowlist } from '../src/config/index.js';

test('parseDigestAllowlist normalizes, lowercases, dedupes and drops blanks', () => {
  assert.deepEqual(parseDigestAllowlist('A@x.com, b@x.com ,,A@X.com'), ['a@x.com', 'b@x.com']);
  assert.deepEqual(parseDigestAllowlist(''), []);
  assert.deepEqual(parseDigestAllowlist(null), []);
});

test('config.digest exposes typed values (driven by .env)', () => {
  assert.equal(typeof config.digest.enabled, 'boolean');
  assert.equal(typeof config.digest.sendHourIst, 'number');
  assert.equal(typeof config.digest.sendMinuteIst, 'number');
  assert.equal(typeof config.digest.tokenTtlHours, 'number');
  assert.ok(Array.isArray(config.digest.allowlist));
});
