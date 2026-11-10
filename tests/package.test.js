'use strict';

require('./helpers/no-real-claude.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

// What the repository may hold (CLAUDE.md): everything else stays on the developer's machine.
const ALLOWED = new Set(['plugin', 'tests', '.github', '.claude-plugin', '.agents', 'README.md', 'LICENSE', 'package.json', '.gitignore']);

/** A clone of the committed tree only, as someone installing from GitHub gets it. */
function freshClone(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-clone-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const clone = path.join(base, 'clone');
  execFileSync('git', ['clone', '-q', ROOT, clone], { stdio: 'ignore' });
  return { base, clone };
}

test('the package and both plugin manifests carry version 1.0.0', () => {
  const versions = ['package.json', 'plugin/.claude-plugin/plugin.json', 'plugin/.codex-plugin/plugin.json'].map((file) => read(file).version);
  assert.deepEqual(versions, ['1.0.0', '1.0.0', '1.0.0']);
});

test('a fresh clone holds only what the repository may hold', (t) => {
  const { clone } = freshClone(t);
  const extra = fs.readdirSync(clone).filter((name) => name !== '.git' && !ALLOWED.has(name));
  assert.deepEqual(extra, []);
});

test('the CLI runs through npm exec from a fresh clone', (t) => {
  const { base, clone } = freshClone(t);
  const result = spawnSync('npm', ['exec', '--yes', `--package=${clone}`, '--cache', path.join(base, 'npm-cache'), '--', 'product-decisions', '--help'], {
    cwd: base,
    encoding: 'utf8',
    // npm is a .cmd script on Windows.
    shell: process.platform === 'win32',
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: product-decisions <command>/);
  assert.match(result.stdout, /import \[--dry-run\]/);
});
