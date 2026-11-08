'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, git } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');
const { runHook, assertSilent, fixture, capturedEvents, storeText, storeOf, walk } = require('./helpers/hook-runner.js');
const { readLocal, writeLocal } = require('../plugin/src/core/state.js');
const { readSessionMeta } = require('../plugin/src/core/store.js');
const { contentHash } = require('../plugin/src/core/event.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'claude-code', 'transcript-import.jsonl');
const SESSION = 'c3d4e5f6-0000-4000-8000-000000000001';
const common = (root) => path.join(root, '.git');

function setup(t) {
  const made = makeRepo();
  t.after(made.cleanup);
  const result = runCli(['init', '--yes', '--no-push'], { cwd: made.root });
  assert.equal(result.status, 0, result.stderr);
  const claudeHome = path.join(made.base, 'claude-home');
  return { ...made, claudeHome, env: { CLAUDE_CONFIG_DIR: claudeHome } };
}

const projectDir = (claudeHome, folder) => path.join(claudeHome, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));

/** Writes the fixture transcript as if Claude Code had kept it for a session opened in `folder`. */
function putFixture(claudeHome, folder, cwd, { sessionId = SESSION, extra = [] } = {}) {
  const dir = projectDir(claudeHome, folder);
  fs.mkdirSync(dir, { recursive: true });
  const text = fs.readFileSync(FIXTURE, 'utf8').split('/home/user/project').join(cwd.split('\\').join('\\\\'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, text + extra.map((record) => `${JSON.stringify(record)}\n`).join(''));
  return file;
}

function putRecords(claudeHome, folder, sessionId, records) {
  const dir = projectDir(claudeHome, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  return file;
}

const record = (type, cwd, uuid, minute, content, extra = {}) => ({
  type, cwd, uuid, sessionId: 'any', gitBranch: 'main', version: '2.1.310', isSidechain: false,
  timestamp: `2026-11-02T09:${String(minute).padStart(2, '0')}:00.000Z`, message: { role: type, content }, ...extra,
});

const sessionEvents = (root, sessionId = SESSION) => capturedEvents(root, { all: true }).filter((event) => event.session_id === sessionId);
const imported = (root, sessionId) => sessionEvents(root, sessionId).filter((event) => event.origin === 'imported' && event.event_type !== 'import');
const runImport = (root, env, args = []) => runCli(['import', ...args], { cwd: root, env });

test('import brings in a past session labelled imported, sealed, and closed', (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  const result = runImport(root, env);
  assert.equal(result.status, 0, result.stderr);

  const events = sessionEvents(root);
  const types = imported(root).map((event) => event.event_type);
  assert.deepEqual(types, [
    'user_prompt', 'agent_response', 'tool_call', 'agent_response', 'tool_failure', 'tool_denied', 'agent_response',
    'user_prompt', 'agent_response', 'compaction',
  ]);
  for (const event of imported(root)) {
    assert.equal(event.origin, 'imported');
    assert.equal(event.git.head, null);
    assert.equal(contentHash(event), event.content_hash);
  }
  assert.equal(Date.parse(imported(root)[0].timestamp), Date.parse('2026-11-01T10:01:00.000Z'), 'the record keeps its own time');
  assert.equal(imported(root)[7].git.branch, 'feature', 'and its own branch');

  const marker = events.find((event) => event.event_type === 'import');
  assert.equal(marker.origin, 'imported');
  assert.equal(marker.payload.importer_version, 1);
  assert.equal(marker.payload.events, 10);
  assert.equal(marker.payload.records_read, 18);
  assert.match(marker.payload.transcript, /\.jsonl$/);
  assert.equal(typeof marker.payload.imported_at, 'string');
  assert.equal(events[events.length - 1].event_type, 'seal');
  assert.equal(readSessionMeta(common(root), 'claude-code', SESSION).closed_through, marker.event_id);

  const verify = runCli(['verify'], { cwd: root });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
});

test('only records whose cwd is inside this repository are imported from an ancestor folder', (t) => {
  const { root, base, claudeHome, env } = setup(t);
  const other = path.join(base, 'other-project');
  putRecords(claudeHome, base, 'from-parent', [
    record('user', other, 'a1', 1, 'Plan the other project.'),
    record('assistant', other, 'a2', 2, [{ type: 'text', text: 'Other project answer.' }]),
    record('user', root, 'a3', 3, 'Now the PRD of this repository.'),
    record('assistant', path.join(root, 'docs'), 'a4', 4, [{ type: 'text', text: 'This repository answer.' }]),
    record('user', base, 'a5', 5, 'Back in the parent folder.'),
  ]);
  assert.equal(runImport(root, env).status, 0);
  const events = imported(root, 'from-parent');
  assert.deepEqual(events.map((event) => event.payload.prompt || event.payload.last_assistant_message), [
    'Now the PRD of this repository.', 'This repository answer.',
  ]);
  assert(!storeText(root).includes('Other project'), 'records from elsewhere leave no trace');
  assert(!storeText(root).includes('Back in the parent'), 'nor do records in the parent folder itself');
});

test('records written during a pause are not imported', (t) => {
  const { root, claudeHome, env } = setup(t);
  const { appendLocalEvent } = require('../plugin/src/cli/shared.js');
  const { locateRepo } = require('../plugin/src/core/locate.js');
  appendLocalEvent(locateRepo(root), readLocal(common(root)), root, {
    eventType: 'gap', summary: 'Capture paused', payload: { from: '2026-11-01T11:05:00+01:00', to: '2026-11-01T10:10:00Z' },
  });
  putFixture(claudeHome, root, root);
  const result = runImport(root, env);
  assert.equal(result.status, 0, result.stderr);
  // Records from 10:05 to 10:10 are left out, so the call made at 10:10 has no record of its result.
  const times = imported(root).map((event) => new Date(event.timestamp).toISOString().slice(11, 16));
  assert.deepEqual(times, ['10:01', '10:04', '10:12', '10:13', '10:15', '10:17']);
  assert.match(result.stdout, /6 while capture was paused/);
});

test('importing twice adds nothing, and a grown transcript adds only its new records', (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  assert.equal(runImport(root, env).status, 0);
  const first = sessionEvents(root).length;

  const again = runImport(root, env);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /Nothing new to import/);
  assert.equal(sessionEvents(root).length, first, 'no event and no seal is added');

  putFixture(claudeHome, root, root, {
    extra: [
      record('user', root, '00000000-0000-4000-8000-000000000201', 30, 'One more thing.'),
      record('assistant', root, '00000000-0000-4000-8000-000000000202', 31, [{ type: 'text', text: 'Done as well.' }]),
    ],
  });
  const grown = runImport(root, env);
  assert.equal(grown.status, 0, grown.stderr);
  const events = sessionEvents(root);
  assert.equal(imported(root).length, 12);
  assert.equal(events.filter((event) => event.event_type === 'import').length, 2);
  assert.equal(events.filter((event) => event.event_type === 'seal').length, 2);
  assert.equal(events[events.length - 1].event_type, 'seal');
  assert.equal(readSessionMeta(common(root), 'claude-code', SESSION).closed_through, events.filter((e) => e.event_type === 'import')[1].event_id);
  assert.equal(runCli(['verify'], { cwd: root }).status, 0);
});

test('a session captured live is skipped whole', (t) => {
  const { root, claudeHome, env } = setup(t);
  const payload = fixture('UserPromptSubmit.json', { cwd: root, session_id: SESSION });
  assertSilent(runHook({ stdin: JSON.stringify(payload), cwd: root, event: 'UserPromptSubmit' }));
  putFixture(claudeHome, root, root);
  const result = runImport(root, env);
  assert.equal(result.status, 0);
  assert.equal(imported(root).length, 0);
  assert.equal(sessionEvents(root).some((event) => event.event_type === 'import'), false);
  assert.match(result.stdout, /1 captured live/);
});

test('redaction, secret-file hashing, and the size limit apply to imported records', (t) => {
  const { root, claudeHome, env } = setup(t);
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const big = 'x'.repeat(9 * 1024 * 1024);
  const records = [
    record('user', root, 'r1', 1, `Use ${token} for the API.`),
    record('assistant', root, 'r2', 2, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(root, '.env') } }]),
    record('user', root, 'r3', 3, [{ type: 'tool_result', tool_use_id: 't1', content: 'DATABASE_URL=plainsecretvalue' }]),
    record('assistant', root, 'r4', 4, [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cat big.log' } }]),
    record('user', root, 'r5', 5, [{ type: 'tool_result', tool_use_id: 't2', content: big }]),
  ];
  putRecords(claudeHome, root, 'secrets', records);
  const result = runImport(root, env);
  assert.equal(result.status, 0, result.stderr);
  const text = storeText(root);
  assert(!text.includes(token), 'the token is redacted');
  assert(!text.includes('plainsecretvalue'), 'the secret file content is not stored');
  const events = imported(root, 'secrets');
  assert.equal(events[1].payload.tool_response.redacted_file, true);
  assert.equal(events[2].payload.oversized, true);
  assert.equal(events[2].payload.transcript_uuid, 'r5', 'an oversized event keeps its key');
  assert(!text.includes('x'.repeat(1000)));

  assert.equal(runImport(root, env).status, 0);
  assert.equal(imported(root, 'secrets').length, 3, 'the oversized record is not imported twice');
});

test('import refuses when not activated, paused, or with stale consent, and writes nothing', (t) => {
  const fresh = makeRepo();
  t.after(fresh.cleanup);
  const claudeHome = path.join(fresh.base, 'claude-home');
  putFixture(claudeHome, fresh.root, fresh.root);
  const inactive = runImport(fresh.root, { CLAUDE_CONFIG_DIR: claudeHome });
  assert.equal(inactive.status, 1);
  assert.equal(inactive.stderr.trim(), 'product-decisions is not active in this repository. Run: product-decisions init');
  assert.equal(fs.existsSync(storeOf(fresh.root)), false);

  const { root, claudeHome: home, env } = setup(t);
  putFixture(home, root, root);
  assert.equal(runCli(['pause'], { cwd: root }).status, 0);
  const paused = runImport(root, env);
  assert.equal(paused.status, 1);
  assert.equal(paused.stderr.trim(), 'Capture is paused here. Run: product-decisions resume');
  assert.equal(walk(path.join(storeOf(root), 'raw', 'claude-code')).length, 0);

  writeLocal(common(root), { ...readLocal(common(root)), paused: false, paused_at: null, consent_sha: 'older-text' });
  const stale = runImport(root, env);
  assert.equal(stale.status, 1);
  assert.equal(stale.stderr.trim(), 'The consent text has changed. Run init to read and accept it before importing.');
  assert.equal(walk(path.join(storeOf(root), 'raw', 'claude-code')).length, 0);
});

test('--dry-run reports and writes nothing', (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  const before = walk(storeOf(root)).map((file) => [file, fs.statSync(file).mtimeMs]);
  const result = runImport(root, env, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would import 1 sessions \(10 events\)\./);
  assert.match(result.stdout, /Dry run: nothing was written\./);
  assert.deepEqual(walk(storeOf(root)).map((file) => [file, fs.statSync(file).mtimeMs]), before);
});

test('--session imports only that session', (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  putRecords(claudeHome, root, 'second', [record('user', root, 's1', 1, 'A second session.')]);
  assert.equal(runImport(root, env, ['--session', 'second']).status, 0);
  assert.equal(imported(root).length, 0);
  assert.equal(imported(root, 'second').length, 1);
});

test('the report names counts and the next step', (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  putRecords(claudeHome, root, 'elsewhere', [record('user', path.join(path.dirname(root), 'x'), 'e1', 1, 'Not here.')]);
  const { stdout, status } = runImport(root, env);
  assert.equal(status, 0);
  assert.match(stdout, /Found 2 transcripts: 2 in the repository, 0 in worktrees, 0 in subfolders, 0 in parent folders\./);
  assert.match(stdout, /Imported 1 sessions \(10 events\)\. Skipped: 0 captured live, 0 already imported, 1 with nothing for this repository\./);
  assert.match(stdout, /Records left out: 1 outside this repository\./);
  assert.match(stdout, /Records skipped by type: meta 1, record:future-record 1, sidechain 1, system:compact_boundary 1, thinking 1\./);
  assert.match(stdout, /Damaged lines: 1\./);
  assert.match(stdout, /Run: product-decisions sync --llm/);
});

test('the worker never treats an unsealed imported session as one of its own', async (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  assert.equal(runImport(root, env).status, 0);
  const file = walk(path.join(storeOf(root), 'raw', 'claude-code'))[0];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, `${lines.slice(0, -1).join('\n')}\n`);
  const { recoverSessions } = require('../plugin/src/worker/turn.js');
  assert.deepEqual(await recoverSessions({ commonDir: common(root) }), []);
});

test('an imported session reaches the folder', (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  assert.equal(runImport(root, env).status, 0);
  const folder = path.join(root, 'product-decisions');
  assert(fs.existsSync(folder), 'the folder exists');
  const files = walk(folder).filter((file) => file.includes(SESSION.slice(0, 8)) || fs.readFileSync(file, 'utf8').includes(SESSION.slice(0, 8)));
  assert(files.length > 0, 'the session appears in the folder');
  assert.equal(git(root, 'status', '--porcelain', '--', 'PRD.md'), '', 'the project files are untouched');
});

test('bash-mode output is never stored, even from a secret file', (t) => {
  const { root, claudeHome, env } = setup(t);
  putRecords(claudeHome, root, 'bash', [
    record('user', root, 'b0', 0, 'Caveat: The messages below were generated by the user while running local commands.', { isMeta: true }),
    record('user', root, 'b1', 1, '<bash-input>cat .env</bash-input>'),
    record('user', root, 'b2', 2, '<bash-stdout>ADMIN_PIN=482913</bash-stdout><bash-stderr></bash-stderr>'),
    record('user', root, 'b3', 3, '<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args></command-args>'),
    record('user', root, 'b4', 4, '<local-command-stdout>Account: person@example.com</local-command-stdout>'),
    record('user', root, 'b5', 5, 'A real prompt.'),
  ]);
  const result = runImport(root, env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(imported(root, 'bash').map((event) => event.payload.prompt), ['A real prompt.']);
  const text = storeText(root);
  assert(!text.includes('482913'));
  assert(!text.includes('person@example.com'));
  assert(!text.includes('cat .env'));
});

test('a record copied into a forked session, or repeated in one file, is imported once', (t) => {
  const { root, claudeHome, env } = setup(t);
  const shared = record('user', root, 'f1', 1, 'The original prompt.');
  putRecords(claudeHome, root, 'orig', [shared]);
  putRecords(claudeHome, root, 'zfork', [shared, record('user', root, 'f2', 2, 'Only in the fork.'), record('user', root, 'f2', 2, 'Only in the fork.')]);
  const dry = runImport(root, env, ['--dry-run']);
  assert.match(dry.stdout, /Would import 2 sessions \(2 events\)\./);
  assert.equal(runImport(root, env).status, 0);
  assert.deepEqual(imported(root, 'orig').map((event) => event.payload.prompt), ['The original prompt.']);
  assert.deepEqual(imported(root, 'zfork').map((event) => event.payload.prompt), ['Only in the fork.']);
});

test('the import marker counts only what is in this repository', (t) => {
  const { root, base, claudeHome, env } = setup(t);
  const other = path.join(base, 'secret-client');
  putRecords(claudeHome, base, 'mixed', [
    record('user', other, 'x1', 1, 'Client work.'),
    record('assistant', other, 'x2', 2, [{ type: 'thinking', thinking: 'client', signature: 's' }, { type: 'image', source: {} }]),
    record('user', root, 'x3', 3, 'Work here.'),
    record('assistant', root, 'x4', 4, [{ type: 'text', text: 'Done here.' }]),
  ]);
  const result = runImport(root, env);
  assert.equal(result.status, 0, result.stderr);
  const marker = sessionEvents(root, 'mixed').find((event) => event.event_type === 'import');
  assert.equal(marker.payload.records_read, 2);
  assert.deepEqual(marker.payload.skipped, {});
  assert.doesNotMatch(result.stdout, /thinking|block:image/);
  assert.match(result.stdout, /Records left out: 2 outside this repository\./);
});

test('records of a repository nested inside this one are not imported', (t) => {
  const { root, claudeHome, env } = setup(t);
  const nested = path.join(root, 'vendor', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q');
  putRecords(claudeHome, root, 'nest', [
    record('user', nested, 'n1', 1, 'Work on the nested library.'),
    record('user', path.join(root, 'gone', 'folder'), 'n2', 2, 'Work in a folder deleted since.'),
  ]);
  assert.equal(runImport(root, env).status, 0);
  assert.deepEqual(imported(root, 'nest').map((event) => event.payload.prompt), ['Work in a folder deleted since.']);
  assert(!storeText(root).includes('nested library'));
});

test('imported events carry the model and Claude Code version from the transcript', (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  assert.equal(runImport(root, env).status, 0);
  for (const event of imported(root)) {
    assert.equal(event.model, 'claude-opus-5-5');
    assert.equal(event.model_source, 'transcript');
    assert.equal(event.tool_version, '2.1.310');
  }
});

test('--session with no id is a usage error and writes nothing', (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  for (const args of [['--session'], ['--session', '--dry-run']]) {
    const result = runImport(root, env, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--session needs a session id/);
  }
  assert.equal(walk(path.join(storeOf(root), 'raw', 'claude-code')).length, 0);
});

test('the hint says how many runs sync --llm would start, and is absent when LLM is off', (t) => {
  const { root, claudeHome, env } = setup(t);
  putFixture(claudeHome, root, root);
  const result = runImport(root, env);
  assert.match(result.stdout, /1 imported sessions wait for LLM synthesis, about 1 runs\. Automatic synthesis leaves them alone; sync --llm runs them all at once, past the daily cap of 10 runs\. Run: product-decisions sync --llm/);

  const off = setup(t);
  writeLocal(common(off.root), { ...readLocal(common(off.root)), llm_enabled: false });
  putFixture(off.claudeHome, off.root, off.root);
  const quiet = runImport(off.root, off.env);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /sync --llm/);
  assert.match(quiet.stdout, /LLM synthesis is off for you here, so imported sessions keep their chronicle only\./);
});
