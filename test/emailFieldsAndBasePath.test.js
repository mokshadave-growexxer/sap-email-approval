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

test('email line table shows Packing, per-kg prices, and item name', () => {
  const html = buildApprovalEmailHtml({
    cardName: 'ACME Ltd',
    documentLines: [
      {
        ItemDescription: 'C12-C16 alcohol ethoxylate',
        FreeText: 'Matpers EK 123',
        Quantity: 10000,
        U_Ex_work_pkg: 1.5,
        U_FOB_pkg: 1.75,
        U_Freight_pkg: 0.2,
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
  // New per-kg price columns (headers + formatted values).
  assert.match(html, /Ex-Work Price \(per kg\)/);
  assert.match(html, /FOB Price \(per kg\)/);
  assert.match(html, /Freight Price \(per kg\)/);
  assert.match(html, /1\.50/); // U_Ex_work_pkg
  assert.match(html, /1\.75/); // U_FOB_pkg
  assert.match(html, /0\.20/); // U_Freight_pkg
  // The three new columns sit before the existing Price column.
  assert.ok(html.indexOf('Freight Price (per kg)') < html.indexOf('>Price<'), 'new columns must precede Price');
  // Product columns still present alongside the new ones.
  assert.match(html, /Product Name/);
  assert.match(html, /Brand Name/);
});

test('empty line table spans all columns', () => {
  const html = buildApprovalEmailHtml({ cardName: 'ACME', documentLines: [], actionUrl: 'https://x/a' });
  assert.match(html, /colspan="11"/);
  assert.match(html, /No draft lines found/);
});
