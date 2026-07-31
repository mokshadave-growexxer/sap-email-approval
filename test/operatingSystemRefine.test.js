import test from 'node:test';
import assert from 'node:assert/strict';
import { refineOperatingSystem } from '../src/services/security/footprintService.js';

test('Windows 10 UA + platformVersion >= 13 is relabelled Windows 11', () => {
  assert.equal(refineOperatingSystem('Windows 10', '15.0.0'), 'Windows 11');
  assert.equal(refineOperatingSystem('Windows 10', '13.0.0'), 'Windows 11');
});

test('Windows 10 UA + platformVersion < 13 stays Windows 10', () => {
  assert.equal(refineOperatingSystem('Windows 10', '10.0.0'), 'Windows 10');
  assert.equal(refineOperatingSystem('Windows 10', '1.0.0'), 'Windows 10');
});

test('missing/undetectable platformVersion leaves the OS untouched', () => {
  assert.equal(refineOperatingSystem('Windows 10', null), 'Windows 10');
  assert.equal(refineOperatingSystem('Windows 10', ''), 'Windows 10');
  assert.equal(refineOperatingSystem('Windows 10', undefined), 'Windows 10');
});

test('non-Windows-10 operating systems are never rewritten', () => {
  assert.equal(refineOperatingSystem('macOS 14.5', '15.0.0'), 'macOS 14.5');
  assert.equal(refineOperatingSystem('Windows 7', '15.0.0'), 'Windows 7');
  assert.equal(refineOperatingSystem(null, '15.0.0'), null);
});
