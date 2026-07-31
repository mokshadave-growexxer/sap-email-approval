import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttachmentPath } from '../src/services/sap/attachmentService.js';

test('builds a Windows UNC attachment path', () => {
  assert.equal(
    buildAttachmentPath('\\\\192.168.10.4\\account\\Common Folder\\Scan Bill', 'RL-4642-2025-26_0001', 'pdf'),
    '\\\\192.168.10.4\\account\\Common Folder\\Scan Bill\\RL-4642-2025-26_0001.pdf'
  );
});

test('trims a trailing separator and joins', () => {
  assert.equal(buildAttachmentPath('C:\\attach\\', 'file', 'txt'), 'C:\\attach\\file.txt');
});

test('handles POSIX-style paths', () => {
  assert.equal(buildAttachmentPath('/mnt/share/docs', 'invoice', 'pdf'), '/mnt/share/docs/invoice.pdf');
});

test('no extension -> just the filename', () => {
  assert.equal(buildAttachmentPath('\\\\srv\\a', 'README', ''), '\\\\srv\\a\\README');
});
