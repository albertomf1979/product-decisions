'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DEFAULT_CONFIG, readConfig, writeConfigCopy, validateFolderName, sanitizeConfig } = require('../plugin/src/core/config.js');
const { CONSENT } = require('../plugin/src/core/consent.js');
const { makeRepo } = require('./helpers/repo.js');

test('the default config is the agreed one', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    schema_version: 1, folder: 'product-decisions', language: 'en', tracked_documents: [], publish: { raw: 'auto' }, redact_patterns: [],
    llm: { enabled: true, engine: 'auto', model: 'sonnet', max_input_chars: 400000, max_runs_per_day: 10, max_budget_usd: 1.00 },
  });
});

test('readConfig gives the default when there is no copy, and the copy when there is', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const common = path.join(root, '.git');
  assert.deepEqual(readConfig(common), DEFAULT_CONFIG);
  writeConfigCopy(common, { ...DEFAULT_CONFIG, language: 'es', tracked_documents: ['PRD.md'] });
  assert.equal(readConfig(common).language, 'es');
  assert.deepEqual(readConfig(common).tracked_documents, ['PRD.md']);
});

test('readConfig fills missing fields from the default', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const common = path.join(root, '.git');
  writeConfigCopy(common, { language: 'es' });
  assert.equal(readConfig(common).folder, 'product-decisions');
  assert.deepEqual(readConfig(common).publish, { raw: 'auto' });
});

test('folder names must be one plain path segment', () => {
  for (const ok of ['product-decisions', 'docs-product', 'record_2026', 'pd']) assert.equal(validateFolderName(ok), true, ok);
  for (const bad of ['', '..', '.', 'a/b', 'a\\b', '../x', '.git', 'with space', '-dash', 'x'.repeat(65)]) assert.equal(validateFolderName(bad), false, bad);
});

test('sanitizeConfig keeps a valid llm block and rejects bad fields one by one', () => {
  const { config, rejected } = sanitizeConfig({ llm: { enabled: false, model: 'haiku', max_runs_per_day: 3 } });
  assert.deepEqual(config.llm, { ...DEFAULT_CONFIG.llm, enabled: false, model: 'haiku', max_runs_per_day: 3 });
  assert.deepEqual(rejected, []);
  const bad = sanitizeConfig({ llm: { engine: 'gpt', model: 'x; rm -rf', max_input_chars: 5, max_runs_per_day: -1, max_budget_usd: 1e9, enabled: 'yes' } });
  assert.deepEqual(bad.config.llm, DEFAULT_CONFIG.llm);
  assert.deepEqual(bad.rejected, ['llm']);
});

test('sanitizeConfig keeps the fallback llm value for a rejected field', () => {
  const fallback = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, model: 'haiku' } };
  const { config, rejected } = sanitizeConfig({ llm: { model: '', max_runs_per_day: 4 } }, fallback);
  assert.equal(config.llm.model, 'haiku');
  assert.equal(config.llm.max_runs_per_day, 4);
  assert.deepEqual(rejected, ['llm']);
});

test('readConfig completes a partial llm block with the defaults', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const common = path.join(root, '.git');
  writeConfigCopy(common, { llm: { model: 'haiku' } });
  assert.deepEqual(readConfig(common).llm, { ...DEFAULT_CONFIG.llm, model: 'haiku' });
});

test("consent text says LLM synthesis spends the person's quota and how to turn it off", () => {
  assert.match(CONSENT, /uses your plan's limits or bills your API key/);
  assert.match(CONSENT, /--no-llm/);
});
