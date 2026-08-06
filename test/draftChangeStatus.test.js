import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovalEmailHtml } from '../src/services/email/approvalEmailService.js';
import { DRAFT_CHANGE_STATUS, getSalesOrderChangeStatus } from '../src/services/sap/draftStatusService.js';

test('getSalesOrderChangeStatus: no ObjectEntry -> CREATED (new Sales Order)', () => {
  for (const objectEntry of [null, undefined, 0, '0', '']) {
    assert.equal(getSalesOrderChangeStatus({ ObjectEntry: objectEntry }).code, 'CREATED');
  }
  assert.equal(getSalesOrderChangeStatus({}).code, 'CREATED');
});

test('getSalesOrderChangeStatus: existing ObjectEntry -> UPDATED (editing an existing SO)', () => {
  assert.equal(getSalesOrderChangeStatus({ ObjectEntry: 67366 }).code, 'UPDATED');
  assert.equal(getSalesOrderChangeStatus({ ObjectEntry: '69340' }).code, 'UPDATED'); // string numeric, as SL sometimes returns
});

function baseArgs(overrides = {}) {
  return {
    approverName: 'Test Approver',
    cardName: 'ACME Corp',
    paymentTermName: '30 Days',
    incoterm: 'FOB Mumbai',
    remark: 'Please arrange in a single batch',
    documentLines: [
      { ItemDescription: 'C12-C16 alcohol ethoxylate', FreeText: 'Croda', Quantity: 10000, Price: 21.12, Currency: 'INR' },
    ],
    actionUrl: 'http://x/action',
    history: [],
    ...overrides,
  };
}

test('CREATED status renders a green "New Sales Order" badge', () => {
  const html = buildApprovalEmailHtml(baseArgs({ changeStatus: DRAFT_CHANGE_STATUS.CREATED }));
  assert.match(html, /NEW SALES ORDER/);
  assert.match(html, /#16a34a/); // green
});

test('UPDATED status renders an amber "Updated Sales Order" badge', () => {
  const html = buildApprovalEmailHtml(baseArgs({ changeStatus: DRAFT_CHANGE_STATUS.UPDATED }));
  assert.match(html, /UPDATED SALES ORDER/);
  assert.match(html, /#d97706/); // amber
});

test('no changeStatus -> no badge (never shows wrong info)', () => {
  const html = buildApprovalEmailHtml(baseArgs({ changeStatus: null }));
  assert.doesNotMatch(html, /SALES ORDER<\/span>/);
});

test('renders only the approved header fields: Customer, Payment Term, Inco Term, Remark', () => {
  const html = buildApprovalEmailHtml(baseArgs());
  assert.match(html, /Customer<\/td><td[^>]*>ACME Corp/);
  assert.match(html, /Payment Term<\/td><td[^>]*>30 Days/);
  assert.match(html, /Incoterms<\/td><td[^>]*>FOB Mumbai/);
  assert.match(html, /Remark<\/td><td[^>]*>Please arrange in a single batch/);
  // dropped header fields must not appear
  assert.doesNotMatch(html, />Document No\.</);
  assert.doesNotMatch(html, />Due Date</);
});

test('line table shows Product Name + Brand Name (FreeText), Quantity and Price only', () => {
  const html = buildApprovalEmailHtml(baseArgs());
  assert.match(html, />Product Name</);
  assert.match(html, />Brand Name</);
  assert.match(html, />Quantity</);
  assert.match(html, />Price</);
  assert.match(html, />Currency</);
  assert.match(html, /C12-C16 alcohol ethoxylate/);
  assert.match(html, />Croda</); // FreeText -> Brand Name column
  assert.match(html, />INR</); // Currency column
  // dropped line columns must not appear
  assert.doesNotMatch(html, />UoM</);
  assert.doesNotMatch(html, />Line Total</);
});
