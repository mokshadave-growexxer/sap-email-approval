import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import {
  companyQueuePath,
  companyQueueFootprintRegisterPath,
  companyQueueClientPath,
  absoluteQueueUrl,
} from '../src/utils/appUrls.js';

test('queue URLs are built under the configured base path', () => {
  const base = config.basePath; // '/salesorder' by default
  assert.equal(companyQueuePath('HASH', 'TOK'), `${base}/api/v1/c/HASH/queue/TOK`);
  assert.equal(
    companyQueueFootprintRegisterPath('HASH', 'TOK'),
    `${base}/api/v1/c/HASH/queue/TOK/footprint/register`
  );
  assert.equal(companyQueueClientPath('HASH'), `${base}/api/v1/c/HASH/queue/client.js`);
});

test('absolute queue URL combines origin, base path and queue route', () => {
  const url = absoluteQueueUrl('HASH', 'TOK');
  assert.ok(url.endsWith(`${config.basePath}/api/v1/c/HASH/queue/TOK`), url);
  assert.ok(url.startsWith(String(config.appBaseUrl).replace(/\/+$/, '')), url);
});
