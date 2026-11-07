'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DEFAULT_CONFIG, readConfig, writeConfigCopy, validateFolderName } = require('../plugin/src/core/config.js');
const { makeRepo } = require('./helpers/repo.js');

test('the default config is the agreed one', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    schema_version: 1, folder: 'product-decisions', language: 'en', tracked_documents: [], publish: { raw: 'auto' }, redact_patterns: [],
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
