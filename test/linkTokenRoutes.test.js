// The "Pending approvals" and draft-retry links carry their signed token in the
// query string (?t=<token>). A JWT path segment is longer than the 260 characters
// IIS's HTTP.sys allows per segment, which made every such link fail with
// "400 Bad Request - Invalid URL" before reaching Node. These tests drive the
// real app over HTTP to prove the emitted links resolve to the routes.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// Point the draft state file at a throwaway directory BEFORE config is imported.
const STATE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'link-token-routes-'));
process.env.DRAFT_POST_STATE_DIR = STATE_DIR;

const { default: app } = await import('../src/app.js');
const { listCompanies } = await import('../src/services/company/companyContext.js');
const {
  companyPendingApprovalsPath,
  companyDraftRetryPath,
  linkTokenFromRequest,
} = await import('../src/utils/appUrls.js');
const { signPendingApprovalsToken } = await import('../src/utils/pendingApprovalsToken.js');
const { signDraftRetryToken } = await import('../src/utils/draftRetryToken.js');
const state = await import('../src/services/sap/draftPostState.js');

const IIS_MAX_SEGMENT = 260;
const company = listCompanies()[0];

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(STATE_DIR, { recursive: true, force: true }).catch(() => {});
});

function longestPathSegment(url) {
  return Math.max(...new URL(url, origin).pathname.split('/').map((s) => s.length));
}

test('pending-approvals and draft-retry links keep every path segment within the IIS limit', () => {
  // A real pending token (UUID process id) is ~270 chars — over the limit as a segment.
  const pendingToken = signPendingApprovalsToken({ processId: '745a67fa-5cbe-43be-bf13-37b2617dbf58' });
  assert.ok(pendingToken.length > IIS_MAX_SEGMENT, 'precondition: the token alone is too long for a segment');
  const retryToken = signDraftRetryToken({ approvalRequestId: 123456789, draftEntry: 123456789 });

  for (const link of [
    companyPendingApprovalsPath(company.hash, pendingToken),
    companyDraftRetryPath(company.hash, retryToken),
  ]) {
    assert.ok(longestPathSegment(link) <= IIS_MAX_SEGMENT, link);
  }
  assert.ok(companyPendingApprovalsPath(company.hash, pendingToken).endsWith(`/pending?t=${pendingToken}`));
  assert.ok(companyDraftRetryPath(company.hash, retryToken).endsWith(`/draft-retry?t=${retryToken}`));
});

test('linkTokenFromRequest reads ?t=, falls back to the legacy path param, and rejects arrays', () => {
  assert.equal(linkTokenFromRequest({ query: { t: 'Q' }, params: { token: 'P' } }), 'Q');
  assert.equal(linkTokenFromRequest({ query: {}, params: { token: 'P' } }), 'P');
  assert.equal(linkTokenFromRequest({ query: { t: ['a', 'b'] }, params: {} }), '');
  assert.equal(linkTokenFromRequest({ query: {}, params: {} }), '');
});

test('pending route reads the token from ?t= (expired token -> 410 Link Expired page)', async () => {
  const expired = signPendingApprovalsToken({ processId: 'p1' }, { expiresIn: -10 });
  const res = await fetch(`${origin}${companyPendingApprovalsPath(company.hash, expired)}`, { redirect: 'manual' });
  assert.equal(res.status, 410);
  assert.match(await res.text(), /Link Expired/);
});

test('pending route without a token, or with a forged one, shows the Invalid Link page', async () => {
  const bare = await fetch(`${origin}${companyPendingApprovalsPath(company.hash, '')}`, { redirect: 'manual' });
  assert.equal(bare.status, 404);
  assert.match(await bare.text(), /Invalid Link/);

  const forged = await fetch(`${origin}${companyPendingApprovalsPath(company.hash, 'not-a-token')}`, {
    redirect: 'manual',
  });
  assert.equal(forged.status, 404);
  assert.match(await forged.text(), /Invalid Link/);
});

test('draft-retry via ?t= clears a parked draft end to end', async () => {
  await state.markParked(company.key, 9101, 9202, {
    attempts: 3,
    classification: 'permanent',
    errorCode: '-1',
    errorMessage: 'test',
  });
  const token = signDraftRetryToken({ approvalRequestId: 9101, draftEntry: 9202 });

  const res = await fetch(`${origin}${companyDraftRetryPath(company.hash, token)}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Queued for retry/);
  const record = await state.getRecord(company.key, 9101, 9202);
  assert.equal(record.state, state.DRAFT_POST_STATE.RETRYING);
});

test('draft-retry still accepts the legacy /draft-retry/<token> path form from alerts already sent', async () => {
  await state.markParked(company.key, 9103, 9204, {
    attempts: 3,
    classification: 'permanent',
    errorCode: '-1',
    errorMessage: 'test',
  });
  const token = signDraftRetryToken({ approvalRequestId: 9103, draftEntry: 9204 });
  const legacy = `${companyDraftRetryPath(company.hash, '').replace(/\?t=$/, '')}/${token}`;

  const res = await fetch(`${origin}${legacy}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Queued for retry/);
});

test('draft-retry with a forged ?t= token is refused', async () => {
  const res = await fetch(`${origin}${companyDraftRetryPath(company.hash, 'forged')}`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not valid/);
});
