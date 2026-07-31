import test from 'node:test';
import assert from 'node:assert/strict';
import { linkApprovalFootprintsToDocument } from '../src/services/sap/footprintDocumentLinker.js';
import { runInCompany, listCompanies } from '../src/services/company/companyContext.js';

const silentLog = { info() {}, warn() {} };
const withCompany = (fn) => runInCompany(listCompanies()[0], fn);

function harness({ docNum = 30033, processes = [{ footprintId: 'fp-1' }, { footprintId: 'fp-2' }] } = {}) {
  const updates = [];
  return {
    updates,
    deps: {
      queryFn: async () => [{ DocNum: docNum }],
      execFn: async (sql, params) => {
        updates.push({ sql, params });
        return 1;
      },
      getProcesses: async () => processes,
      log: silentLog,
    },
  };
}

test('links every footprint of the request with docEntry, docNum and changeType', async () => {
  const { updates, deps } = harness({ docNum: 30033 });
  const linked = await withCompany(() =>
    linkApprovalFootprintsToDocument({ approvalRequestId: '130847', docEntry: 71739, changeType: 'UPDATED' }, deps)
  );
  assert.equal(linked, 2);
  assert.equal(updates.length, 2);
  assert.match(updates[0].sql, /UPDATE\s+.+"@AP_FOOTPRINT".+SET\s+"U_doc_entry"\s*=\s*\?,\s*"U_doc_num"\s*=\s*\?,\s*"U_change_type"\s*=\s*\?\s+WHERE\s+"Code"\s*=\s*\?/is);
  assert.deepEqual(updates[0].params, [71739, 30033, 'UPDATED', 'fp-1']);
  assert.deepEqual(updates[1].params, [71739, 30033, 'UPDATED', 'fp-2']);
});

test('skips footprints with no id and tolerates a missing ORDR row (null docNum)', async () => {
  const { updates, deps } = harness({ processes: [{ footprintId: 'fp-1' }, { footprintId: null }] });
  deps.queryFn = async () => []; // ORDR row not found yet
  const linked = await withCompany(() =>
    linkApprovalFootprintsToDocument({ approvalRequestId: 1, docEntry: 999, changeType: 'CREATED' }, deps)
  );
  assert.equal(linked, 1);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params, [999, null, 'CREATED', 'fp-1']);
});

test('is a no-op without an approvalRequestId or docEntry', async () => {
  const { updates, deps } = harness();
  assert.equal(await linkApprovalFootprintsToDocument({ approvalRequestId: null, docEntry: 1, changeType: 'CREATED' }, deps), 0);
  assert.equal(await linkApprovalFootprintsToDocument({ approvalRequestId: 1, docEntry: '', changeType: 'CREATED' }, deps), 0);
  assert.equal(updates.length, 0);
});

test('never throws when the DB fails', async () => {
  const linked = await withCompany(() =>
    linkApprovalFootprintsToDocument(
      { approvalRequestId: 1, docEntry: 1, changeType: 'CREATED' },
      { queryFn: async () => { throw new Error('db down'); }, execFn: async () => 1, getProcesses: async () => [], log: silentLog }
    )
  );
  assert.equal(linked, 0);
});
