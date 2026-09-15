import test from 'node:test';
import assert from 'node:assert/strict';
import { renderQueuePage } from '../src/routes/queue.js';
import { config } from '../src/config/index.js';

const items = [
  {
    processId: 'p-1',
    approvalRequestId: '1001',
    docNum: 10016,
    cardName: 'NexChemia Tradex FZ-LLC',
    docDate: '2026-09-01',
    paymentTermName: '100% advance',
    incoterm: 'CIF',
    portOfLoading: 'Nhava Sheva (INNSA)',
    portOfDischarge: 'Jebel Ali (AEJEA)',
    destinationCountry: 'United Arab Emirates',
    labelType: 'Private Label',
    remark: '',
    documentLines: [
      { ItemDescription: 'Nonyl Phenol', U_Pcode: 'PCPM0132', Quantity: 100, U_Freight_pkg: 0.45, Price: 2.25, Currency: 'USD' },
    ],
    itemCount: 1,
    orderValue: 225,
    currency: 'USD',
    changeType: 'UPDATED',
    history: [{ name: 'sap01', stageCode: 1, decidedAt: '2026-09-04 11:20:31' }],
  },
  {
    processId: 'p-2',
    approvalRequestId: '1002',
    docNum: 10023,
    cardName: 'Bharat Surfactants',
    docDate: '2026-09-05',
    paymentTermName: '30 days',
    incoterm: 'Ex-Works',
    remark: 'Revised packing',
    documentLines: [],
    itemCount: 0,
    orderValue: 0,
    currency: '',
    changeType: 'CREATED',
  },
];

test('the queue page lists each SO with a checkbox carrying its process id', () => {
  const html = renderQueuePage({ token: 'TOK', companyHash: 'HASH', approverName: 'Moksha', items });
  assert.match(html, /name="selected" value="p-1"/);
  assert.match(html, /name="selected" value="p-2"/);
  assert.match(html, /10016/);
  assert.match(html, /NexChemia Tradex FZ-LLC/);
  assert.match(html, /Updated/);
  assert.match(html, /New/);
});

test('the dropdown shows the full order — every header field and approval history', () => {
  const html = renderQueuePage({ token: 'TOK', companyHash: 'HASH', approverName: 'Moksha', items });
  // All header fields a single-SO approval shows are present in the detail panel.
  assert.match(html, /Port of Loading/);
  assert.match(html, /Nhava Sheva \(INNSA\)/);
  assert.match(html, /Port of Discharge/);
  assert.match(html, /Jebel Ali \(AEJEA\)/);
  assert.match(html, /Destination Country/);
  assert.match(html, /United Arab Emirates/);
  assert.match(html, /Label Type/);
  assert.match(html, /Private Label/);
  assert.match(html, /Payment Term/);
  // Approval history so far.
  assert.match(html, /Approved by <b>sap01<\/b>/);
  // The full line-item table is still there, now with a Total Freight column.
  assert.match(html, /Packing Name/);
  assert.match(html, /Ex-Work/);
  assert.match(html, /Total Freight/);
  assert.match(html, /45\.00/); // 100 qty x 0.45 freight/kg
});

test('dropdowns are open by default and omit fields already shown in the header', () => {
  const html = renderQueuePage({ token: 'TOK', companyHash: 'HASH', approverName: 'M', items });
  assert.match(html, /class="so-row expanded"/); // open on load
  assert.doesNotMatch(html, /so-items-panel" hidden/); // not collapsed initially
  assert.doesNotMatch(html, /Document Date/); // removed from the dropdown (header shows the date)
  assert.doesNotMatch(html, /Order Value/); // removed from the dropdown (header shows the value)
});

test('the form posts to the company queue path and loads the queue client script', () => {
  const html = renderQueuePage({ token: 'TOK', companyHash: 'HASH', approverName: 'M', items });
  assert.match(html, new RegExp(`action="${config.basePath}/api/v1/c/HASH/queue/TOK"`));
  assert.match(html, new RegExp(`data-register-url="${config.basePath}/api/v1/c/HASH/queue/TOK/footprint/register"`));
  assert.match(html, new RegExp(`src="${config.basePath}/api/v1/c/HASH/queue/client\\.js"`));
});

test('Approve and Reject are submit buttons, disabled until the client enables them', () => {
  const html = renderQueuePage({ token: 'TOK', companyHash: 'HASH', approverName: 'M', items });
  assert.match(html, /name="decision" value="approve"[^>]*disabled/);
  assert.match(html, /name="decision" value="reject"[^>]*disabled/);
  assert.match(html, /id="selectAll"/);
  assert.match(html, /name="remarks"/);
});

test('no password field on the normal page', () => {
  const html = renderQueuePage({ token: 'TOK', companyHash: 'HASH', approverName: 'M', items });
  assert.doesNotMatch(html, /name="sap_password"/);
});

test('the enrollment render shows a password field and pre-checks the prior selection', () => {
  const html = renderQueuePage({
    token: 'TOK',
    companyHash: 'HASH',
    approverName: 'M',
    items,
    needsPassword: true,
    selectedIds: new Set(['p-1']),
    remarks: 'note',
    message: 'First time here',
    messageKind: 'info',
  });
  assert.match(html, /<input[^>]*type="password"[^>]*name="sap_password"[^>]*required/);
  assert.match(html, /name="selected" value="p-1"[^>]*checked/);
  assert.match(html, /name="remarks"[^>]*value="note"/);
  assert.match(html, /First time here/);
});

test('an empty queue shows the empty state', () => {
  const html = renderQueuePage({ token: 'TOK', companyHash: 'HASH', approverName: 'M', items: [] });
  assert.match(html, /no pending sales order approvals/i);
});
