import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigestEmailHtml, buildDigestSubject } from '../src/services/email/digestEmailService.js';

const items = [
  { docNum: 10016, cardName: 'NexChemia Tradex FZ-LLC', orderValue: 39600, currency: 'USD', docDate: '2026-09-01', changeType: 'UPDATED' },
  { docNum: 10023, cardName: 'Bharat Surfactants Pvt Ltd', orderValue: 740000, currency: 'INR', docDate: '2026-09-05', changeType: 'CREATED' },
];

test('subject states how many approvals are awaiting', () => {
  assert.equal(buildDigestSubject(2), 'Pending Sales Order Approvals — 2 awaiting your decision');
  assert.equal(buildDigestSubject(0), 'Pending Sales Order Approvals — 0 awaiting your decision');
});

test('digest email lists every pending SO with customer, value and a Take Action link', () => {
  const html = buildDigestEmailHtml({ approverName: 'Moksha', items, actionUrl: 'https://x/salesorder/api/v1/c/H/queue/T' });
  assert.match(html, /Here is the list of all pending sales order approvals/);
  assert.match(html, /10016/);
  assert.match(html, /NexChemia Tradex FZ-LLC/);
  assert.match(html, /10023/);
  assert.match(html, /Bharat Surfactants Pvt Ltd/);
  assert.match(html, /39,600\.00/); // formatted order value
  assert.match(html, /USD/);
  assert.match(html, /01\/09\/2026/); // dd/mm/yyyy
  assert.match(html, /UPDATED/);
  assert.match(html, /NEW/);
  assert.match(html, /href="https:\/\/x\/salesorder\/api\/v1\/c\/H\/queue\/T"/);
  assert.match(html, /Take Action/);
});

test('an empty digest renders a no-approvals row', () => {
  const html = buildDigestEmailHtml({ approverName: 'X', items: [], actionUrl: 'https://x/q' });
  assert.match(html, /No pending approvals/);
});
