'use strict';

// P2 from the PRD: the plugin writes only inside <git-common-dir>/product-decisions/.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, activate, git } = require('./helpers/repo.js');
const { runHook, assertSilent, fixture, fixtureNames, walk, capturedEvents } = require('./helpers/hook-runner.js');

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = (files) => Object.fromEntries(files.map((file) => [file, hash(file)]));

test('a full fixture cycle changes nothing outside the store', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, 'notes.md'), 'a project file\n');
  activate(root);

  const gitDir = path.join(root, '.git');
  const store = path.join(gitDir, 'product-decisions');
  const outsideStore = () => walk(root).filter((file) => !file.startsWith(store + path.sep));

  const before = {
    status: git(root, 'status', '--porcelain'),
    head: git(root, 'rev-parse', 'HEAD'),
    files: hashes(outsideStore()),
  };

  for (const name of fixtureNames()) {
    const payload = fixture(name, { cwd: root });
    assertSilent(runHook({ stdin: JSON.stringify(payload), cwd: root, event: payload.hook_event_name }), name);
  }

  assert(capturedEvents(root).length > 0, 'the cycle must have captured something');
  assert.equal(git(root, 'status', '--porcelain'), before.status);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before.head);
  assert.deepEqual(hashes(outsideStore()), before.files);
});
