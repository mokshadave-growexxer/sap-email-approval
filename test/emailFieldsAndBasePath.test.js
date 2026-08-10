import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovalEmailHtml } from '../src/services/email/approvalEmailService.js';
import { config, normalizeBasePath } from '../src/config/index.js';
import {
  apiBasePath,
  companyActionPath,
  companyFootprintClientPath,
  companyFootprintRegisterPath,
  absoluteActionUrl,
} from '../src/utils/appUrls.js';

test('normalizeBasePath yields a clean single-segment prefix or empty', () => {
  assert.equal(normalizeBasePath('/salesorder'), '/salesorder');
  assert.equal(normalizeBasePath('salesorder'), '/salesorder');
  assert.equal(normalizeBasePath('/salesorder/'), '/salesorder');
  assert.equal(normalizeBasePath('/sales/order/'), '/sales/order');
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath(null), '');
});

test('every app URL is built under the configured base path', () => {
  const base = config.basePath; // '/salesorder' by default
  assert.equal(apiBasePath(), `${base}/api/v1`);
  assert.equal(companyActionPath('HASH', 'PID'), `${base}/api/v1/c/HASH/action/PID`);
  assert.equal(companyFootprintRegisterPath('HASH'), `${base}/api/v1/c/HASH/footprint/register`);
  assert.equal(companyFootprintClientPath('HASH'), `${base}/api/v1/c/HASH/footprint/client.js`);
});

test('absolute action URL combines origin, base path and action route', () => {
  const url = absoluteActionUrl('HASH', 'PID');
  assert.ok(url.endsWith(`${config.basePath}/api/v1/c/HASH/action/PID`), url);
  assert.ok(url.startsWith(String(config.appBaseUrl).replace(/\/+$/, '')), url);
});

test('base path defaults to /salesorder', () => {
  assert.equal(config.basePath, '/salesorder');
});

test('approval links do not expire by time (default TTL is 0)', () => {
  assert.equal(config.approvalLinkTtlHours, 0);
});

test('email line table shows Packing Code (U_Pcode) and its item name', () => {
  const html = buildApprovalEmailHtml({
    cardName: 'ACME Ltd',
    documentLines: [
      {
        ItemDescription: 'C12-C16 alcohol ethoxylate',
        FreeText: 'Matpers EK 123',
        Quantity: 10000,
        Price: 24.473,
        Currency: 'INR',
        U_Pcode: 'PCPM0010',
        PackingItemName: 'Tank IBC (white) UN Certified-55-58kg',
      },
    ],
    actionUrl: 'https://sapapproval.example.com/salesorder/api/v1/c/H/action/P',
  });

  assert.match(html, /Packing Code/);
  assert.match(html, /Packing Name/);
  assert.match(html, /PCPM0010/);
  assert.match(html, /Tank IBC \(white\) UN Certified-55-58kg/);
  // Product columns still present alongside the new ones.
  assert.match(html, /Product Name/);
  assert.match(html, /Brand Name/);
});

test('empty line table spans all eight columns', () => {
  const html = buildApprovalEmailHtml({ cardName: 'ACME', documentLines: [], actionUrl: 'https://x/a' });
  assert.match(html, /colspan="8"/);
  assert.match(html, /No draft lines found/);
});
