import test from 'node:test';
import assert from 'node:assert/strict';
import { isTestAllowedRecipient } from '../src/services/email/approvalEmailService.js';

// Time-gated delivery (allowlist window vs real approver) is covered in
// emailDeliveryRules.test.js. This file pins the allowlist membership itself.

test('only the two test addresses are on the allowlist', () => {
  assert.equal(isTestAllowedRecipient('sap1@matangiindustries.com'), true);
  assert.equal(isTestAllowedRecipient('moksha.dave@growexx.com'), true);
  assert.equal(isTestAllowedRecipient('MOKSHA.DAVE@growexx.com'), true); // case-insensitive
  assert.equal(isTestAllowedRecipient('  sap1@matangiindustries.com '), true); // trimmed
});

test('any other address is off the allowlist', () => {
  assert.equal(isTestAllowedRecipient('someone.else@growexx.com'), false);
  assert.equal(isTestAllowedRecipient('sap1@matangi.com'), false);
  assert.equal(isTestAllowedRecipient(''), false);
  assert.equal(isTestAllowedRecipient(null), false);
  assert.equal(isTestAllowedRecipient(undefined), false);
});
