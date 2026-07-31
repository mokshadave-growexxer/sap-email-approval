import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompanies } from '../src/config/index.js';
import {
  listCompanies,
  getCompanyByKey,
  getCompanyByHash,
  runInCompany,
  currentCompany,
  currentSchema,
  currentSL,
  currentCompanyHash,
} from '../src/services/company/companyContext.js';

test('parseCompanies: parses key:schema pairs (schema == companyDb)', () => {
  const companies = parseCompanies('millp:ZZ_TMILLP_01_04_26,mspl:ZZ_TMSPL_15_07_26');
  assert.deepEqual(companies, [
    { key: 'millp', schema: 'ZZ_TMILLP_01_04_26', companyDb: 'ZZ_TMILLP_01_04_26' },
    { key: 'mspl', schema: 'ZZ_TMSPL_15_07_26', companyDb: 'ZZ_TMSPL_15_07_26' },
  ]);
});

test('parseCompanies: trims, rejects malformed entries and duplicate keys, falls back', () => {
  assert.deepEqual(parseCompanies(' a : S1 '), [{ key: 'a', schema: 'S1', companyDb: 'S1' }]);
  assert.throws(() => parseCompanies('noColon'), /expected "key:schema"/);
  assert.throws(() => parseCompanies('a:S1,a:S2'), /Duplicate company key/);
  assert.deepEqual(parseCompanies('', { fallbackSchema: 'S', fallbackCompanyDb: 'C' }), [
    { key: 'default', schema: 'S', companyDb: 'C' },
  ]);
  assert.throws(() => parseCompanies(''), /No SAP company configured/);
});

test('registry exposes every configured company with a stable opaque hash', () => {
  const companies = listCompanies();
  assert.ok(companies.length >= 1);
  for (const c of companies) {
    assert.match(c.hash, /^[0-9a-f]{32}$/); // 128-bit hex, schema name never exposed
    assert.equal(getCompanyByHash(c.hash).key, c.key);
    assert.equal(getCompanyByKey(c.key).schema, c.schema);
    assert.notEqual(c.hash, c.schema); // the URL token is not the raw schema
  }
  // hashes are unique per company
  const hashes = new Set(companies.map((c) => c.hash));
  assert.equal(hashes.size, companies.length);
});

test('getCompanyByHash returns null for an unknown hash', () => {
  assert.equal(getCompanyByHash('deadbeef'), null);
  assert.equal(getCompanyByHash(''), null);
});

test('runInCompany activates the right context; nested contexts do not leak', async () => {
  const [first] = listCompanies();
  await runInCompany(first, async () => {
    assert.equal(currentCompany().key, first.key);
    assert.equal(currentSchema(), first.schema);
    assert.equal(currentCompanyHash(), first.hash);
    assert.equal(currentSL().companyDb, first.companyDb); // SL session bound to this company
  });
});

test('currentSchema/currentSL throw outside any company context (fail-loud)', () => {
  assert.throws(() => currentSchema(), /No active company context/);
  assert.throws(() => currentSL(), /No active company context/);
  assert.throws(() => currentCompanyHash(), /No active company context/);
});

test('runInCompany rejects an unknown company key', () => {
  assert.throws(() => runInCompany('nope', () => {}), /Unknown company/);
});
