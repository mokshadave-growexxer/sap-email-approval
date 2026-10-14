import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import {
  canDeliverToRecipient,
  buildApprovalSubject,
  resolveBccRecipient,
} from '../src/services/email/approvalEmailService.js';

const UNTIL = config.emailAllowlistUntil;
const before = new Date(UNTIL.getTime() - 60_000);
const after = new Date(UNTIL.getTime() + 60_000);

function withEmailMode(mode, fn) {
  const prev = config.emailMode;
  config.emailMode = mode;
  try {
    fn();
  } finally {
    config.emailMode = prev;
  }
}

test('before the cutoff, development delivers only to the allowlist', () => {
  withEmailMode('development', () => {
    assert.equal(canDeliverToRecipient('sap1@matangiindustries.com', before), true);
    assert.equal(canDeliverToRecipient('real.approver@matangiindustries.com', before), false);
  });
});

test('at/after the cutoff, development delivers to the real approver', () => {
  withEmailMode('development', () => {
    assert.equal(canDeliverToRecipient('real.approver@matangiindustries.com', after), true);
    assert.equal(canDeliverToRecipient('real.approver@matangiindustries.com', UNTIL), true);
  });
});

test('production delivers to any recipient regardless of the cutoff', () => {
  withEmailMode('production', () => {
    assert.equal(canDeliverToRecipient('real.approver@matangiindustries.com', before), true);
  });
});

test('subject carries the SO number and the DocDate (dd/mm/yyyy)', () => {
  assert.equal(buildApprovalSubject(30064, '2026-09-09'), 'Approval Required: Sales Order 30064 / 09/09/2026');
  assert.equal(buildApprovalSubject(30064, '2026-09-09T00:00:00Z'), 'Approval Required: Sales Order 30064 / 09/09/2026');
  assert.equal(buildApprovalSubject(30064, ''), 'Approval Required: Sales Order 30064');
  assert.equal(buildApprovalSubject(30064, null), 'Approval Required: Sales Order 30064');
});

test('BCC is every configured monitoring address, deduped against the recipient', () => {
  const configured = String(config.emailBcc)
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean);

  assert.equal(resolveBccRecipient('real.approver@matangiindustries.com'), configured.join(','));

  // An approver who is themselves a monitoring address is not also BCC'd.
  const withoutFirst = configured.slice(1).join(',') || undefined;
  assert.equal(resolveBccRecipient(configured[0]), withoutFirst);
  assert.equal(resolveBccRecipient(configured[0].toUpperCase()), withoutFirst);
});

test('BCC parses lists, trims, dedupes and drops the recipient', () => {
  assert.equal(resolveBccRecipient('a@x.com', 'b@x.com, c@x.com'), 'b@x.com,c@x.com');
  assert.equal(resolveBccRecipient('a@x.com', ' b@x.com ; c@x.com '), 'b@x.com,c@x.com');
  assert.equal(resolveBccRecipient('B@X.COM', 'b@x.com, c@x.com'), 'c@x.com');
  assert.equal(resolveBccRecipient('a@x.com', 'b@x.com, B@x.com'), 'b@x.com');
  assert.equal(resolveBccRecipient('b@x.com', 'b@x.com'), undefined);
  assert.equal(resolveBccRecipient('a@x.com', ' , ; '), undefined);
  assert.equal(resolveBccRecipient('a@x.com', ''), undefined);
  assert.equal(resolveBccRecipient('a@x.com', null), undefined);
});
