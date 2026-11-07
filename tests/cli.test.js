'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLocal } = require('../plugin/src/core/state.js');
const { contentHash } = require('../plugin/src/core/event.js');
const { makeRepo, git } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');
const { runHook, assertSilent, fixture, capturedEvents, storeText, storeOf, walk } = require('./helpers/hook-runner.js');

function repo(t, options) {
  const made = makeRepo(options);
  t.after(made.cleanup);
  return made;
}
const common = (root) => path.join(root, '.git');
const ofType = (root, type) => capturedEvents(root).filter((event) => event.event_type === type);
const init = (root) => runCli(['init', '--yes'], { cwd: root });
const hook = (root, name, overrides = {}) => {
  const payload = fixture(name, { cwd: root, ...overrides });
  assertSilent(runHook({ stdin: JSON.stringify(payload), cwd: root, event: payload.hook_event_name }));
};

test('init outside a repository fails with exit 1 and a clear message', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['init', '--yes'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not inside a Git repository/i);
});

test('init with --yes activates and stores the Git name', (t) => {
  const { root } = repo(t);
  const result = init(root);
  assert.equal(result.status, 0, result.stderr);
  const state = readLocal(common(root));
  assert.equal(state.activated, true);
  assert.equal(state.paused, false);
  assert.equal(state.actor_name, 'Test Person');
  assert.match(state.machine, /^[0-9a-f]{8}$/);
  assert.deepEqual(state.redact_patterns, []);
});

test('init shows what is recorded and where it goes', (t) => {
  const { root } = repo(t);
  const { stdout } = init(root);
  assert.match(stdout, /What is recorded/);
  assert.match(stdout, /Where it goes: first to \.git\/product-decisions on this machine/);
  assert.match(stdout, /product-decisions\/docs/);
  assert.match(stdout, /product-decisions pause/);
});

test('init says that sessions already open are captured too', (t) => {
  const { root } = repo(t);
  assert.match(init(root).stdout, /including any already open/);
});

test('init does not promise more than the plugin enforces about secret files', (t) => {
  const { root } = repo(t);
  const { stdout } = init(root);
  assert(!/never stored/.test(stdout));
  assert.match(stdout, /printed indirectly/);
});

test('init writes a consent event that records the statement', (t) => {
  const { root } = repo(t);
  init(root);
  const [event] = ofType(root, 'consent');
  assert.equal(event.tool, 'cli');
  assert.equal(event.session_id, 'local');
  assert.deepEqual(event.actor, { type: 'user', name: 'Test Person' });
  assert.match(event.payload.statement, /What is recorded/);
  assert.equal(contentHash(event), event.content_hash);
});

test('init with no Git user.name uses "unknown" and warns', (t) => {
  const { root } = repo(t);
  git(root, 'config', '--unset', 'user.name');
  const missing = path.join(os.tmpdir(), 'pd-no-such-git-config');
  const result = runCli(['init', '--yes'], { cwd: root, env: { GIT_CONFIG_GLOBAL: missing, GIT_CONFIG_SYSTEM: missing } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readLocal(common(root)).actor_name, 'unknown');
  assert.match(result.stderr, /user\.name/);
});

test('init without --yes and without a terminal refuses, and activates nothing', (t) => {
  const { root } = repo(t);
  const result = runCli(['init'], { cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--yes/);
  assert.equal(readLocal(common(root)), null);
  assert.equal(fs.existsSync(storeOf(root)), false);
});

test('init twice stays activated, and does not repeat consent', (t) => {
  const { root } = repo(t);
  init(root);
  const first = readLocal(common(root));
  const again = init(root);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already active/i);
  assert.deepEqual(readLocal(common(root)), first);
  assert.equal(ofType(root, 'consent').length, 1);
});

test('init from a linked worktree activates the whole repository', (t) => {
  const { root } = repo(t);
  const wt = path.join(path.dirname(root), 'wt');
  git(root, 'worktree', 'add', '-q', '-b', 'wt', wt);
  assert.equal(runCli(['init', '--yes'], { cwd: wt }).status, 0);
  assert.equal(readLocal(common(root)).activated, true);
});

test('pause stops capture', (t) => {
  const { root } = repo(t);
  init(root);
  assert.equal(runCli(['pause'], { cwd: root }).status, 0);
  const state = readLocal(common(root));
  assert.equal(state.paused, true);
  assert.equal(typeof state.paused_at, 'string');
  hook(root, 'UserPromptSubmit.json', { prompt: 'MARKER-WHILE-PAUSED' });
  assert.equal(ofType(root, 'user_prompt').length, 0);
  assert(!storeText(root).includes('MARKER-WHILE-PAUSED'));
});

test('resume restores capture and writes one gap event with no content', (t) => {
  const { root } = repo(t);
  init(root);
  runCli(['pause'], { cwd: root });
  const pausedAt = readLocal(common(root)).paused_at;
  hook(root, 'UserPromptSubmit.json', { prompt: 'MARKER-WHILE-PAUSED' });
  assert.equal(runCli(['resume'], { cwd: root }).status, 0);

  const state = readLocal(common(root));
  assert.equal(state.paused, false);
  assert.equal(state.paused_at, null);

  const gaps = ofType(root, 'gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].payload.from, pausedAt);
  assert.equal(typeof gaps[0].payload.to, 'string');
  assert.deepEqual(Object.keys(gaps[0].payload).sort(), ['from', 'to']);
  assert(!storeText(root).includes('MARKER-WHILE-PAUSED'));

  hook(root, 'UserPromptSubmit.json', { prompt: 'after resume' });
  assert.equal(ofType(root, 'user_prompt').length, 1);
});

test('pause twice keeps the first time, and resume without pause adds no gap', (t) => {
  const { root } = repo(t);
  init(root);
  runCli(['pause'], { cwd: root });
  const first = readLocal(common(root)).paused_at;
  assert.equal(runCli(['pause'], { cwd: root }).status, 0);
  assert.equal(readLocal(common(root)).paused_at, first);
  runCli(['resume'], { cwd: root });
  assert.equal(runCli(['resume'], { cwd: root }).status, 0);
  assert.equal(ofType(root, 'gap').length, 1);
});

test('pause and resume on an inactive repository fail with exit 1', (t) => {
  const { root } = repo(t);
  for (const command of ['pause', 'resume']) {
    const result = runCli([command], { cwd: root });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /not active/i);
  }
  assert.equal(fs.existsSync(storeOf(root)), false);
});

test('status --json reports the agreed shape', (t) => {
  const { root } = repo(t);
  init(root);
  hook(root, 'SessionStart-startup.json', { session_id: 'one' });
  hook(root, 'Stop.json', { session_id: 'one' });
  hook(root, 'Stop.json', { session_id: 'two' });
  const result = runCli(['status', '--json'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(status).sort(), ['activated', 'actor', 'capture_hint', 'errors', 'latency', 'paused', 'project', 'publication', 'repo', 'runtime', 'seals', 'store', 'tools']);
  assert.equal(status.repo.root, root);
  assert.equal(status.activated, true);
  assert.equal(status.paused, false);
  assert.equal(status.actor, 'Test Person');
  assert.deepEqual(Object.keys(status.tools), ['claude-code']);
  assert.equal(status.tools['claude-code'].sessions, 2);
  assert.equal(status.tools['claude-code'].events, 3);
  assert.match(status.tools['claude-code'].last_event_at, /^\d{4}-/);
  assert(status.store.bytes > 0);
  assert.equal(status.latency.count, 3);
  assert(status.latency.p50 > 0 && status.latency.p95 >= status.latency.p50);
  assert.deepEqual(status.errors, { count: 0, last_at: null });
  assert.equal(status.runtime.cli_node, process.version);
  assert.match(status.runtime.git, /\d+\.\d+/);
});

test('status counts errors', (t) => {
  const { root } = repo(t);
  init(root);
  assertSilent(runHook({ stdin: '{broken', cwd: root }));
  const status = JSON.parse(runCli(['status', '--json'], { cwd: root }).stdout);
  assert.equal(status.errors.count, 1);
  assert.match(status.errors.last_at, /^\d{4}-/);
});

test('status ignores an incomplete last line', (t) => {
  const { root } = repo(t);
  init(root);
  hook(root, 'Stop.json', { session_id: 'one' });
  const file = walk(path.join(storeOf(root), 'raw', 'claude-code'))[0];
  fs.appendFileSync(file, '{"event_id":"partial');
  const status = JSON.parse(runCli(['status', '--json'], { cwd: root }).stdout);
  assert.equal(status.tools['claude-code'].events, 1);
});

test('status on an inactive repository says so, with exit 0', (t) => {
  const { root } = repo(t);
  const text = runCli(['status'], { cwd: root });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /not active/i);
  const json = JSON.parse(runCli(['status', '--json'], { cwd: root }).stdout);
  assert.equal(json.activated, false);
  assert.equal(fs.existsSync(storeOf(root)), false);
});

test('status outside a repository fails with exit 1', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(runCli(['status'], { cwd: dir }).status, 1);
});

test('status text shows the state and has no payload content', (t) => {
  const { root } = repo(t);
  init(root);
  hook(root, 'UserPromptSubmit.json', { prompt: 'MARKER-IN-PROMPT' });
  const { stdout } = runCli(['status'], { cwd: root });
  assert.match(stdout, /active/i);
  assert.match(stdout, /claude-code/);
  assert.match(stdout, /p95/);
  assert(!stdout.includes('MARKER'));
});

test('status text shows a paused state', (t) => {
  const { root } = repo(t);
  init(root);
  runCli(['pause'], { cwd: root });
  assert.match(runCli(['status'], { cwd: root }).stdout, /paused/i);
});

test('the CLI writes only inside its own boundary (PRD P2)', (t) => {
  const { root } = repo(t);
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const snapshot = () => Object.fromEntries(walk(root).map((file) => [path.relative(root, file).split(path.sep).join('/'), hash(file)]));
  // Its folder, its store, its refs and the objects behind them, and one exclude line.
  const allowed = (file) => file.startsWith('product-decisions/') || file.startsWith('.git/product-decisions/')
    || file === '.git/info/exclude' || file.startsWith('.git/objects/')
    || file.startsWith('.git/refs/heads/product-decisions/') || file.startsWith('.git/logs/refs/heads/product-decisions/');
  const before = { files: snapshot(), status: git(root, 'status', '--porcelain'), head: git(root, 'rev-parse', 'HEAD') };
  for (const args of [['init', '--yes'], ['status'], ['pause'], ['resume'], ['status', '--json'], ['sync', '--no-push']]) {
    assert.equal(runCli(args, { cwd: root }).status, 0, args.join(' '));
  }
  const after = snapshot();
  const touched = [...new Set([...Object.keys(before.files), ...Object.keys(after)])].filter((file) => before.files[file] !== after[file]);
  assert.deepEqual(touched.filter((file) => !allowed(file)), []);
  assert.equal(git(root, 'status', '--porcelain'), before.status);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before.head);
});

test('help works, and an unknown command fails', (t) => {
  const { root } = repo(t);
  const help = runCli(['--help'], { cwd: root });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /init/);
  const none = runCli([], { cwd: root });
  assert.equal(none.status, 1);
  const unknown = runCli(['nope'], { cwd: root });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command/);
});

// Project declaration, joining, and the local folder (M2).
const { DOCS_REF, readRef, readTreeFiles, readBlob } = require('../plugin/src/git/plumbing.js');
const { readConfig } = require('../plugin/src/core/config.js');

function withRemote(t) {
  const { root, base } = repo(t);
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  return { root, base, remote };
}
const docsConfig = (root) => JSON.parse(readBlob(root, readTreeFiles(root, readRef(root, DOCS_REF)).get('config.json')).toString());

test('the first init creates the docs branch with config.json and nothing on code branches', (t) => {
  const { root } = repo(t);
  const before = { head: git(root, 'rev-parse', 'HEAD'), branches: git(root, 'branch', '--list') };
  const result = runCli(['init', '--yes', '--language', 'es', '--track', 'PRD.md'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(docsConfig(root), { schema_version: 1, folder: 'product-decisions', language: 'es', tracked_documents: ['PRD.md'], publish: { raw: 'auto' }, redact_patterns: [] });
  assert.equal(git(root, 'rev-parse', 'HEAD'), before.head);
  assert.deepEqual(git(root, 'branch', '--format=%(refname:short)').split('\n').sort(), ['main', 'product-decisions/docs']);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(readConfig(common(root)).language, 'es');
});

test('init creates the folder, excluded and invisible', (t) => {
  const { root } = repo(t);
  init(root);
  assert.equal(fs.existsSync(path.join(root, 'product-decisions', 'config.json')), true);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('a second person joins an existing declaration from the remote and keeps its config', (t) => {
  const { root, base, remote } = withRemote(t);
  runCli(['init', '--yes', '--language', 'es', '--track', 'PRD.md'], { cwd: root });
  git(root, 'push', '-q', 'origin', DOCS_REF);
  const second = path.join(base, 'second');
  git(base, 'clone', '-q', remote, second);
  git(second, 'config', 'user.name', 'Second Person');
  const result = runCli(['init', '--yes', '--language', 'en'], { cwd: second });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Joined/);
  assert.equal(readConfig(path.join(second, '.git')).language, 'es');
  assert.deepEqual(readConfig(path.join(second, '.git')).tracked_documents, ['PRD.md']);
  assert.equal(readRef(second, DOCS_REF), readRef(root, DOCS_REF));
});

test('re-running init after activation completes a missing declaration', (t) => {
  const { root } = repo(t);
  init(root);
  // Simulate an M1 activation: no declaration yet.
  git(root, 'update-ref', '-d', DOCS_REF);
  fs.rmSync(path.join(common(root), 'product-decisions', 'config.json'), { force: true });
  const again = runCli(['init', '--yes'], { cwd: root });
  assert.equal(again.status, 0, again.stderr);
  assert.notEqual(readRef(root, DOCS_REF), null);
  assert.equal(ofType(root, 'consent').length, 1);
});

test('--track on a missing file fails clearly, and changes nothing', (t) => {
  const { root } = repo(t);
  const result = runCli(['init', '--yes', '--track', 'NOPE.md'], { cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NOPE\.md/);
  assert.equal(fs.existsSync(storeOf(root)), false);
  assert.equal(readRef(root, DOCS_REF), null);
});

test('the consent event records flag or interactive', (t) => {
  const { root } = repo(t);
  init(root);
  assert.equal(ofType(root, 'consent')[0].payload.method, 'flag');
});

test('the consent event is written before the state, so a failed append activates nothing', (t) => {
  const { root } = repo(t);
  fs.mkdirSync(path.join(storeOf(root), 'raw'), { recursive: true });
  fs.writeFileSync(path.join(storeOf(root), 'raw', 'cli'), 'a file where a folder should be');
  const result = runCli(['init', '--yes'], { cwd: root });
  assert.equal(result.status, 1);
  assert.equal(readLocal(common(root)), null);
});

test('init on a paused repository says so', (t) => {
  const { root } = repo(t);
  init(root);
  runCli(['pause'], { cwd: root });
  assert.match(runCli(['init', '--yes'], { cwd: root }).stdout, /paused/i);
});

test('a folder name that exists in the project is refused, with nothing changed', (t) => {
  const { root } = repo(t);
  fs.mkdirSync(path.join(root, 'product-decisions'));
  fs.writeFileSync(path.join(root, 'product-decisions', 'real.md'), 'project content');
  const result = runCli(['init', '--yes'], { cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--folder/);
  assert.equal(readLocal(common(root)), null);
  const other = runCli(['init', '--yes', '--folder', 'decision-record'], { cwd: root });
  assert.equal(other.status, 0, other.stderr);
  assert.equal(fs.existsSync(path.join(root, 'decision-record', 'config.json')), true);
  assert.equal(fs.readFileSync(path.join(root, 'product-decisions', 'real.md'), 'utf8'), 'project content');
});

test('a folder name with path separators or .. is refused', (t) => {
  const { root } = repo(t);
  for (const folder of ['../out', 'a/b', '..']) {
    const result = runCli(['init', '--yes', '--folder', folder], { cwd: root });
    assert.equal(result.status, 1, folder);
  }
  assert.equal(readLocal(common(root)), null);
});

test('init works with no commits, and on a detached HEAD', (t) => {
  const { root: empty, cleanup } = makeRepo({ commit: false });
  t.after(cleanup);
  assert.equal(init(empty).status, 0);
  assert.notEqual(readRef(empty, DOCS_REF), null);
  const { root } = repo(t);
  git(root, 'checkout', '-q', '--detach');
  assert.equal(init(root).status, 0);
});

test('init from a linked worktree creates the folder in the main checkout', (t) => {
  const { root } = repo(t);
  const wt = path.join(path.dirname(root), 'wt');
  git(root, 'worktree', 'add', '-q', '-b', 'wt', wt);
  assert.equal(runCli(['init', '--yes'], { cwd: wt }).status, 0);
  assert.equal(fs.existsSync(path.join(root, 'product-decisions')), true);
  assert.equal(fs.existsSync(path.join(wt, 'product-decisions')), false);
});

test('after git clean -fdx, or after deleting the folder, sync restores it', (t) => {
  const { root } = repo(t);
  init(root);
  git(root, 'clean', '-q', '-fdx');
  assert.equal(fs.existsSync(path.join(root, 'product-decisions')), false);
  assert.equal(runCli(['sync', '--no-push'], { cwd: root }).status, 0);
  assert.equal(fs.existsSync(path.join(root, 'product-decisions', 'config.json')), true);
  fs.rmSync(path.join(root, 'product-decisions'), { recursive: true });
  runCli(['sync', '--no-push'], { cwd: root });
  assert.equal(fs.existsSync(path.join(root, 'product-decisions', 'config.json')), true);
});

test('patterns in the project config are redacted, along with the personal ones', (t) => {
  const { root } = repo(t);
  init(root);
  const config = readConfig(common(root));
  require('../plugin/src/core/config.js').writeConfigCopy(common(root), { ...config, redact_patterns: ['PROJECT-[0-9]+'] });
  hook(root, 'UserPromptSubmit.json', { prompt: 'about PROJECT-42' });
  assert(!storeText(root).includes('PROJECT-42'));
});

test('init gives the activated state a private salt', (t) => {
  const { root } = repo(t);
  init(root);
  assert.match(readLocal(common(root)).salt, /^[0-9a-f]{64}$/);
});

test('status shows the project, publication, and seal state', async (t) => {
  const { root } = repo(t);
  runCli(['init', '--yes', '--track', 'PRD.md', '--language', 'es'], { cwd: root });
  hook(root, 'UserPromptSubmit.json', { session_id: 'st-1' });
  assert.equal(runCli(['sync', '--no-push'], { cwd: root }).status, 0);
  const status = JSON.parse(runCli(['status', '--json'], { cwd: root }).stdout);
  assert.deepEqual(status.project, { declared: true, folder: 'product-decisions', language: 'es', tracked_documents: ['PRD.md'] });
  assert.equal(status.publication.remote, null);
  assert.equal(status.publication.docs_pending, false);
  assert.equal(status.seals.problems, 0);
  assert.equal(status.seals.unsealed_events, 0);
  assert(status.seals.sessions >= 1);
  const text = runCli(['status'], { cwd: root }).stdout;
  assert.match(text, /Project: declared/);
  assert.match(text, /no remote/);
  assert.match(text, /Seals:/);
});

test('status keeps counting across rotated logs', (t) => {
  const { root } = repo(t);
  init(root);
  const logs = path.join(storeOf(root), 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'latency.jsonl.1'), Array.from({ length: 5 }, (_, i) => JSON.stringify({ ms: 10 + i })).join('\n') + '\n');
  fs.writeFileSync(path.join(logs, 'latency.jsonl'), `${JSON.stringify({ ms: 30 })}\n`);
  fs.writeFileSync(path.join(logs, 'diagnostics.log.1'), `${JSON.stringify({ ts: 'a' })}\n${JSON.stringify({ ts: 'b' })}\n`);
  const status = JSON.parse(runCli(['status', '--json'], { cwd: root }).stdout);
  assert.equal(status.latency.count, 6);
  assert.equal(status.errors.count, 2);
});

test('status counts events across read chunks in a large file, and only lines that parse', (t) => {
  const { root } = repo(t);
  init(root);
  const file = path.join(storeOf(root), 'raw', 'claude-code', 'big-m.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ origin: 'hook', timestamp: '2026-11-07T10:00:00+01:00', pad: 'x'.repeat(900) });
  const body = Array.from({ length: 3000 }, () => line).join('\n');
  fs.writeFileSync(file, `${body}\nnot json\n${line}\n{"partial`);
  const status = JSON.parse(runCli(['status', '--json'], { cwd: root }).stdout);
  assert.equal(status.tools['claude-code'].events, 3001);
});

test('status warns when transcripts are newer than the last captured event', (t) => {
  const { root, base } = repo(t);
  init(root);
  const home = path.join(base, 'home');
  const projects = path.join(home, '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'some-session.jsonl'), '{}\n');
  const status = JSON.parse(runCli(['status', '--json'], { cwd: root, env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' } }).stdout);
  assert.match(String(status.capture_hint), /after the last captured event/);
  const quiet = JSON.parse(runCli(['status', '--json'], { cwd: root, env: { HOME: path.join(base, 'empty-home'), USERPROFILE: path.join(base, 'empty-home'), CLAUDE_CONFIG_DIR: '' } }).stdout);
  assert.equal(quiet.capture_hint, null);
});
