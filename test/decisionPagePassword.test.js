import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDecisionPage } from '../src/routes/approval.js';

const process = { approval_request_id: '130908', level: 1, user_code: 'sap01' };

test('the normal decision page has no password field', () => {
  const html = renderDecisionPage({ process, processId: 'p1', companyHash: 'HASH' });
  // No actual password input (the CSS selector for one may still exist).
  assert.doesNotMatch(html, /name="sap_password"/);
  assert.doesNotMatch(html, /<input[^>]*type="password"/);
  // The action buttons are still present.
  assert.match(html, /name="decision" value="approve"/);
  assert.match(html, /name="decision" value="reject"/);
});

test('the enrollment page shows a password field and the notice', () => {
  const html = renderDecisionPage({
    process,
    processId: 'p1',
    companyHash: 'HASH',
    needsPassword: true,
    messageKind: 'info',
    message: 'First time here — please enter your SAP password once.',
  });
  assert.match(html, /<input[^>]*type="password"[^>]*name="sap_password"[^>]*required/);
  assert.match(html, /First time here/);
});
