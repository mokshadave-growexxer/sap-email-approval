import test from 'node:test';
import assert from 'node:assert/strict';
import { getClientIp, parseUserAgent, DEVICE_TYPE } from '../src/services/security/footprintService.js';
import { formatLocalTime } from '../src/services/audit/decisionLogService.js';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WINDOWS_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

test('getClientIp strips IPv4-mapped IPv6 prefix', () => {
  assert.equal(getClientIp({ ip: '::ffff:203.0.113.5' }), '203.0.113.5');
});

test('getClientIp preserves plain IPv6 and IPv4', () => {
  assert.equal(getClientIp({ ip: '::1' }), '::1');
  assert.equal(getClientIp({ ip: '198.51.100.7' }), '198.51.100.7');
});

test('getClientIp returns null when absent', () => {
  assert.equal(getClientIp({}), null);
  assert.equal(getClientIp(null), null);
});

test('parseUserAgent classifies mobile / tablet / desktop', () => {
  assert.equal(parseUserAgent(IPHONE_UA).deviceType, DEVICE_TYPE.MOBILE);
  assert.equal(parseUserAgent(IPAD_UA).deviceType, DEVICE_TYPE.TABLET);
  assert.equal(parseUserAgent(WINDOWS_CHROME_UA).deviceType, DEVICE_TYPE.DESKTOP);
});

test('parseUserAgent extracts OS and browser', () => {
  const desktop = parseUserAgent(WINDOWS_CHROME_UA);
  assert.match(desktop.operatingSystem, /Windows/);
  assert.match(desktop.browser, /Chrome/);
});

test('parseUserAgent handles empty UA as Desktop with null fields', () => {
  const r = parseUserAgent('');
  assert.equal(r.deviceType, DEVICE_TYPE.DESKTOP);
  assert.equal(r.operatingSystem, null);
  assert.equal(r.browser, null);
});

test('formatLocalTime renders client-zone wall clock with abbreviation', () => {
  const utcInstant = new Date('2026-07-17T08:15:00Z');
  assert.equal(formatLocalTime(utcInstant, 'Asia/Kolkata'), '2026-07-17 13:45 IST');
  assert.equal(formatLocalTime(utcInstant, 'UTC'), '2026-07-17 08:15 UTC');
});

test('formatLocalTime falls back to UTC on missing or invalid timezone', () => {
  const utcInstant = new Date('2026-07-17T08:15:00Z');
  assert.equal(formatLocalTime(utcInstant, null), '2026-07-17 08:15 UTC');
  assert.equal(formatLocalTime(utcInstant, 'Not/AZone'), '2026-07-17 08:15 UTC');
});
