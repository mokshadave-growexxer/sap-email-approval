import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSapUser } from '../src/services/email/approvalEmailService.js';

const HIMANSHU = Object.freeze({ userCode: 'sales01', email: 'himanshu@example.com', name: 'President - Sales & Marketing' });
const sldDown = async () => {
  throw new Error('Request failed with status code 500'); // "Fail to connect to SLD"
};

test('Service Layer answer is used as-is; HANA is not read', async () => {
  let hanaReads = 0;
  const user = await resolveSapUser(156, {
    fromServiceLayer: async () => HIMANSHU,
    fromHana: async () => {
      hanaReads += 1;
      return null;
    },
  });
  assert.deepEqual(user, HIMANSHU);
  assert.equal(hanaReads, 0);
});

test('when the Service Layer fails, the approver is read from HANA OUSR', async () => {
  const seen = [];
  const user = await resolveSapUser(156, {
    fromServiceLayer: sldDown,
    fromHana: async (id) => {
      seen.push(id);
      return HIMANSHU;
    },
  });
  assert.deepEqual(user, HIMANSHU);
  assert.deepEqual(seen, [156]);
});

test('an empty Service Layer answer also falls back to HANA', async () => {
  const user = await resolveSapUser(156, {
    fromServiceLayer: async () => ({ userCode: null, email: null, name: null }),
    fromHana: async () => HIMANSHU,
  });
  assert.deepEqual(user, HIMANSHU);
});

test('when both fail the approver stays unresolved (never throws)', async () => {
  const user = await resolveSapUser(156, { fromServiceLayer: sldDown, fromHana: sldDown });
  assert.deepEqual(user, { userCode: null, email: null, name: null });
});

test('an unknown user in HANA stays unresolved', async () => {
  const user = await resolveSapUser(999, { fromServiceLayer: sldDown, fromHana: async () => null });
  assert.deepEqual(user, { userCode: null, email: null, name: null });
});
