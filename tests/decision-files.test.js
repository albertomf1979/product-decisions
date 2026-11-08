'use strict';

// Create-once files across a team: ADRs from two people, edits on the docs branch, and
// damaged data from the shared branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readLocal } = require('../plugin/src/core/state.js');
const { DOCS_REF, git: plumbingGit, readRef, readTreeFiles, readBlob } = require('../plugin/src/git/plumbing.js');
const { publish } = require('../plugin/src/worker/publish.js');
const { overlayDir } = require('../plugin/src/worker/render.js');
const { makeRepo, git } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');

const common = (root) => path.resolve(root, plumbingGit(['rev-parse', '--git-common-dir'], { cwd: root }).stdout.toString().trim());
const vis = (value) => async () => value;
const docs = (repo) => readTreeFiles(repo, readRef(repo, DOCS_REF));
const blobAt = (repo, file) => readBlob(repo, docs(repo).get(file)).toString();

function team(t) {
  const { root, base, cleanup } = makeRepo();
  t.after(cleanup);
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  assert.equal(runCli(['init', '--yes'], { cwd: root }).status, 0);
  const clone = (name, activate = true) => {
    const dir = path.join(base, name);
    git(base, 'clone', '-q', remote, dir);
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'user.email', `${name}@example.com`);
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'maintenance.auto', 'false');
    if (activate) assert.equal(runCli(['init', '--yes'], { cwd: dir }).status, 0);
    return dir;
  };
  return { root, remote, clone };
}

function writeAdr(root, id, { title = `Title ${id}`, body = 'ORIGINAL' } = {}) {
  const overlay = overlayDir(common(root));
  const file = `decisions/${id}-title.md`;
  fs.mkdirSync(path.join(overlay, 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(overlay, '.data', 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(overlay, file), `# ${id}: ${title}\n\n${body}\n`);
  fs.writeFileSync(path.join(overlay, '.data', 'decisions', `${id}.json`), JSON.stringify({
    schema_version: 1, id, title, file, at: '2026-11-05T10:00:00+01:00', session: 's1', session_file: 'timeline/x.md', tool: 'claude-code',
    decided_by: { type: 'user', name: readLocal(common(root)).actor_name }, evidence: ['01KAAAAAAAAAAAAAAAAAAA0001'], related: [], supersedes: [],
  }));
  return file;
}

test("an ADR edited on the docs branch survives its author's next publish", async (t) => {
  const { root, remote, clone } = team(t);
  const file = writeAdr(root, 'ADR-20261105-aaaaaa');
  await publish({ commonDir: common(root), visibilityOf: vis('private') });
  assert.match(blobAt(remote, file), /ORIGINAL/);

  const editor = clone('editor', false);
  git(editor, 'fetch', '-q', 'origin', `${DOCS_REF}:${DOCS_REF}`);
  git(editor, 'switch', '-q', 'product-decisions/docs');
  fs.writeFileSync(path.join(editor, file), fs.readFileSync(path.join(editor, file), 'utf8').replace('ORIGINAL', 'EDITED BY A PERSON'));
  git(editor, 'commit', '-q', '-am', 'Correct an ADR');
  git(editor, 'push', '-q', 'origin', 'product-decisions/docs');

  await publish({ commonDir: common(root), visibilityOf: vis('private') });
  assert.match(blobAt(remote, file), /EDITED BY A PERSON/);
});

test("two people's ADRs from the same day both reach the merged index", async (t) => {
  const { root, remote, clone } = team(t);
  const ben = clone('ben');
  writeAdr(root, 'ADR-20261105-aaaaaa');
  writeAdr(ben, 'ADR-20261105-bbbbbb');
  await publish({ commonDir: common(root), visibilityOf: vis('private') });
  await publish({ commonDir: common(ben), visibilityOf: vis('private') });
  await publish({ commonDir: common(root), visibilityOf: vis('private') });
  const readme = blobAt(remote, 'README.md');
  assert.ok(readme.includes('ADR-20261105-aaaaaa') && readme.includes('ADR-20261105-bbbbbb'));
  assert.ok(docs(remote).has('decisions/ADR-20261105-aaaaaa-title.md') && docs(remote).has('decisions/ADR-20261105-bbbbbb-title.md'));
});

test('damaged decision or note data is skipped, not fatal', async (t) => {
  const { root, remote } = team(t);
  writeAdr(root, 'ADR-20261105-aaaaaa');
  const overlay = overlayDir(common(root));
  fs.writeFileSync(path.join(overlay, '.data', 'decisions', 'ADR-20261105-ffffff.json'), '{ not json');
  fs.writeFileSync(path.join(overlay, '.data', 'decisions', 'ADR-20261105-eeeeee.json'), JSON.stringify({ schema_version: 1, id: 'ADR-20261105-eeeeee', title: 'x', file: '../../etc/passwd' }));
  fs.mkdirSync(path.join(overlay, '.data', 'phases'), { recursive: true });
  fs.writeFileSync(path.join(overlay, '.data', 'phases', 'bad.json'), JSON.stringify({ schema_version: 1, phase: 'marketing' }));
  await publish({ commonDir: common(root), visibilityOf: vis('private') });
  const readme = blobAt(remote, 'README.md');
  assert.ok(readme.includes('ADR-20261105-aaaaaa'));
  assert.ok(!readme.includes('ADR-20261105-eeeeee'));
});
