import test from 'node:test';
import assert from 'node:assert/strict';
import { writeDecisionRemark } from '../src/services/sap/decisionRemarkStore.js';
import { runInCompany, listCompanies } from '../src/services/company/companyContext.js';

const silentLog = { info() {}, warn() {} };
const withCompany = (fn) => runInCompany(listCompanies()[0], fn);

function recorder(result = 1) {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return result;
  };
  return { calls, exec };
}

test('writeDecisionRemark targets the approver line by WddCode + UserID', async () => {
  const { calls, exec } = recorder(1);
  const ok = await withCompany(() =>
    writeDecisionRemark({ approvalRequestId: '130852', sapUserId: 72, remark: '  ship it  ' }, { exec, log: silentLog })
  );
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].sql,
    /UPDATE\s+".+"\."WDD1"\s+SET\s+"Remarks"\s*=\s*\?\s+WHERE\s+"WddCode"\s*=\s*\?\s+AND\s+"UserID"\s*=\s*\?/i
  );
  assert.deepEqual(calls[0].params, ['ship it', 130852, 72]); // trimmed remark, numeric keys
});

test('writeDecisionRemark is a no-op for empty/missing input (never writes)', async () => {
  const { calls, exec } = recorder(1);
  await withCompany(async () => {
    assert.equal(await writeDecisionRemark({ approvalRequestId: '1', sapUserId: 1, remark: '   ' }, { exec, log: silentLog }), false);
    assert.equal(await writeDecisionRemark({ approvalRequestId: null, sapUserId: 1, remark: 'x' }, { exec, log: silentLog }), false);
    assert.equal(await writeDecisionRemark({ approvalRequestId: '1', sapUserId: null, remark: 'x' }, { exec, log: silentLog }), false);
  });
  assert.equal(calls.length, 0);
});

test('writeDecisionRemark caps remark at 254 chars', async () => {
  const { calls, exec } = recorder(1);
  await withCompany(() => writeDecisionRemark({ approvalRequestId: 1, sapUserId: 1, remark: 'y'.repeat(300) }, { exec, log: silentLog }));
  assert.equal(calls[0].params[0].length, 254);
});

test('writeDecisionRemark never throws on a DB failure', async () => {
  const throwing = async () => {
    throw new Error('db down');
  };
  const ok = await withCompany(() =>
    writeDecisionRemark({ approvalRequestId: 1, sapUserId: 1, remark: 'x' }, { exec: throwing, log: silentLog })
  );
  assert.equal(ok, false);
});
