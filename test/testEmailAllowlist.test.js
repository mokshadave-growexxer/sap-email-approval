import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { isTestAllowedRecipient, canDeliverToRecipient } from '../src/services/email/approvalEmailService.js';

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

test('development EMAIL_MODE delivers only to allowlisted addresses', () => {
  const prev = config.emailMode;
  config.emailMode = 'development';
  try {
    assert.equal(canDeliverToRecipient('sap1@matangiindustries.com'), true);
    assert.equal(canDeliverToRecipient('real.approver@matangiindustries.com'), false);
  } finally {
    config.emailMode = prev;
  }
});

test('production EMAIL_MODE delivers to any real approver address', () => {
  const prev = config.emailMode;
  config.emailMode = 'production';
  try {
    assert.equal(canDeliverToRecipient('real.approver@matangiindustries.com'), true);
    assert.equal(canDeliverToRecipient('sap1@matangiindustries.com'), true);
  } finally {
    config.emailMode = prev;
  }
});
