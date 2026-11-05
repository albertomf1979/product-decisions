'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'plugin', 'scripts', 'hook.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'claude-code');

const factor = Number(process.env.PD_LATENCY_FACTOR || 1);

const cleanEnv = (env) => {
  const merged = { ...process.env, ...env };
  if (!env || !('PRODUCT_DECISIONS_SYNTH' in env)) delete merged.PRODUCT_DECISIONS_SYNTH;
  return merged;
};

/** Runs the real hook process to completion. */
function runHook({ stdin = '', cwd = process.cwd(), event = 'Stop', tool = 'claude-code', env, hookPath = HOOK, args } = {}) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [hookPath, ...(args || [tool, event])], {
    input: stdin,
    cwd,
    env: cleanEnv(env),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: performance.now() - start };
}

/** Runs the hook without waiting, optionally leaving stdin open. */
function runHookAsync({ stdin, cwd = process.cwd(), event = 'Stop', tool = 'claude-code', env, hookPath = HOOK, keepStdinOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [hookPath, tool, event], { cwd, env: cleanEnv(env) });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (c) => stdout.push(c));
    child.stderr.on('data', (c) => stderr.push(c));
    child.on('error', reject);
    child.on('close', (status) => resolve({
      status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), ms: performance.now() - start,
    }));
    if (stdin !== undefined) child.stdin.write(stdin);
    if (!keepStdinOpen) child.stdin.end();
  });
}

function assertSilent(result, label = '') {
  assert.equal(result.status, 0, `${label}: exit code`);
  assert.equal(result.stdout.length, 0, `${label}: stdout: ${result.stdout}`);
  assert.equal(result.stderr.length, 0, `${label}: stderr: ${result.stderr}`);
}

const fixtureNames = () => fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

/** Loads a fixture as an object with some fields replaced. */
function fixture(name, overrides = {}) {
  return { ...JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')), ...overrides };
}

/** Lists every file below a directory. */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const storeOf = (root) => path.join(root, '.git', 'product-decisions');

/** Parses every captured event under a repository's store. */
function capturedEvents(root) {
  return walk(path.join(storeOf(root), 'raw')).flatMap((file) =>
    fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

/** All text under the store, to prove something is absent. */
const storeText = (root) => walk(storeOf(root)).map((file) => fs.readFileSync(file, 'latin1')).join('\n');

/** Copies the plugin to another location, for path tests and fault injection. */
function copyPlugin(base, name) {
  const target = path.join(base, name);
  fs.cpSync(path.join(__dirname, '..', '..', 'plugin'), target, { recursive: true });
  return target;
}

module.exports = {
  HOOK, factor, runHook, runHookAsync, assertSilent, fixtureNames, fixture, walk, storeOf, capturedEvents, storeText, copyPlugin,
};
