'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { storeDir, readLocal, writeLocal, isCapturing, machineId } = require('../plugin/src/core/state.js');
const { makeRepo } = require('./helpers/repo.js');

const sample = { schema_version: 1, activated: true, activated_at: 'x', actor_name: 'Ana', machine: 'm', paused: false, paused_at: null, redact_patterns: [] };

test('storeDir lives inside the common dir', () => {
  assert.equal(storeDir(path.join('a', '.git')), path.join('a', '.git', 'product-decisions'));
});

test('readLocal returns null when the file is missing', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  assert.equal(readLocal(path.join(root, '.git')), null);
});

test('readLocal returns null on corrupt content, without throwing', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const common = path.join(root, '.git');
  fs.mkdirSync(storeDir(common));
  fs.writeFileSync(path.join(storeDir(common), 'local.json'), '{not json');
  assert.equal(readLocal(common), null);
});

test('readLocal returns null when the store is a file, without throwing', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const common = path.join(root, '.git');
  fs.writeFileSync(storeDir(common), 'a file');
  assert.equal(readLocal(common), null);
});

test('writeLocal round-trips and leaves no temp file', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const common = path.join(root, '.git');
  writeLocal(common, sample);
  assert.deepEqual(readLocal(common), sample);
  assert.deepEqual(fs.readdirSync(storeDir(common)), ['local.json']);
});

test('isCapturing is true only when activated and not paused', () => {
  assert.equal(isCapturing(sample), true);
  assert.equal(isCapturing({ ...sample, paused: true }), false);
  assert.equal(isCapturing({ ...sample, activated: false }), false);
  assert.equal(isCapturing(null), false);
});

test('machineId is stable and 8 hex characters', () => {
  assert.match(machineId(), /^[0-9a-f]{8}$/);
  assert.equal(machineId(), machineId());
});
