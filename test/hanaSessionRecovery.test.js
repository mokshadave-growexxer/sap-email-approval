import test from 'node:test';
import assert from 'node:assert/strict';
import { isStatementError } from '../src/services/sap/hanaClient.js';

// A session left in a server-refused state (the licence lockdown of Oct 2026)
// keeps reporting itself as connected, so the only way out is to classify the
// error as "not a statement error" and discard the connection. Getting this
// classification wrong in the unsafe direction costs an outage that only a
// process restart ends, so the rules are pinned here.

test('plain SQL errors keep the session (they are the statement\'s fault, not the session\'s)', () => {
  assert.equal(isStatementError({ code: 257, message: 'sql syntax error: incorrect syntax near ")"' }), true);
  assert.equal(isStatementError({ code: 258, message: 'insufficient privilege: Not authorized' }), true);
  assert.equal(isStatementError({ code: 259, message: 'invalid table name: Could not find table/view X' }), true);
  assert.equal(isStatementError({ code: 260, message: 'invalid column name: U_nope' }), true);
  assert.equal(isStatementError({ code: 301, message: 'unique constraint violated' }), true);
  assert.equal(isStatementError({ code: 304, message: 'division by zero undefined' }), true);
  assert.equal(isStatementError({ code: 399, message: 'last code in the statement band' }), true);
  assert.equal(isStatementError({ code: 1299, message: 'no data found' }), true);
});

test('the licence lockdown error discards the session, whatever code it carries', () => {
  const lockdown = 'only commands for license handling are allowed in current state';
  assert.equal(isStatementError({ code: 438, message: lockdown }), false);
  // Even if it ever arrived with a code inside the statement band, the message wins.
  assert.equal(isStatementError({ code: 300, message: lockdown }), false);
  assert.equal(isStatementError({ message: lockdown }), false);
  assert.equal(isStatementError(new Error(lockdown)), false);
  assert.equal(isStatementError({ code: 1, message: 'system is locked down' }), false);
  assert.equal(isStatementError({ code: 1, message: 'licence check failed' }), false);
});

test('anything outside the statement band discards the session', () => {
  assert.equal(isStatementError({ code: 129, message: 'transaction rolled back by an internal error' }), false);
  assert.equal(isStatementError({ code: 131, message: 'transaction rolled back by lock wait timeout' }), false);
  assert.equal(isStatementError({ code: 256, message: 'just below the band' }), false);
  assert.equal(isStatementError({ code: 400, message: 'just above the band' }), false);
  assert.equal(isStatementError({ code: 613, message: 'transaction cancelled by the system' }), false);
  assert.equal(isStatementError({ code: -10807, message: 'socket closed by peer' }), false);
});

test('an error with no usable code is treated as unsafe, never as a statement error', () => {
  assert.equal(isStatementError({ message: 'something the driver did not classify' }), false);
  assert.equal(isStatementError({ code: null, message: 'no code' }), false);
  assert.equal(isStatementError({ code: 'ETIMEDOUT', message: 'timed out' }), false);
  assert.equal(isStatementError(new Error('bare error')), false);
  assert.equal(isStatementError(undefined), false);
  assert.equal(isStatementError(null), false);
});
