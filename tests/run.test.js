'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { contentHash } = require('../plugin/src/core/event.js');
const { makeRepo, addWorktree, activate, git } = require('./helpers/repo.js');
const { runHook, assertSilent, fixture, fixtureNames, storeOf, capturedEvents, storeText, copyPlugin, walk } = require('./helpers/hook-runner.js');
const { corpus } = require('./helpers/secrets.js');

function activeRepo(t, options, state) {
  const repo = makeRepo(options);
  t.after(repo.cleanup);
  activate(repo.root, state);
  return repo;
}

const send = (root, name, overrides = {}) => {
  const payload = fixture(name, { cwd: root, ...overrides });
  const result = runHook({ stdin: JSON.stringify(payload), cwd: root, event: payload.hook_event_name });
  assertSilent(result, name);
};

test('an active repository gets one valid line per event', (t) => {
  const { root } = activeRepo(t);
  const names = fixtureNames();
  for (const name of names) send(root, name);
  const events = capturedEvents(root);
  assert.equal(events.length, names.length);
  for (const event of events) {
    assert.equal(event.schema_version, 1);
    assert.equal(event.tool, 'claude-code');
    assert.equal(contentHash(event), event.content_hash);
    assert.equal(typeof event.summary, 'string');
    assert.deepEqual(event.git.branch, 'main');
  }
});

test('events carry the person from the local state, with no email', (t) => {
  const { root } = activeRepo(t);
  send(root, 'UserPromptSubmit.json');
  const [event] = capturedEvents(root);
  assert.deepEqual(event.actor, { type: 'user', name: 'Test Person' });
  assert(!storeText(root).includes('test@example.com'));
});

test('one file per session and machine', (t) => {
  const { root } = activeRepo(t);
  send(root, 'Stop.json', { session_id: 'aaa' });
  send(root, 'Stop.json', { session_id: 'bbb' });
  send(root, 'SessionEnd-other.json', { session_id: 'aaa' });
  const files = walk(path.join(storeOf(root), 'raw')).map((f) => path.basename(f)).sort();
  assert.deepEqual(files, ['aaa-abcd1234.jsonl', 'bbb-abcd1234.jsonl']);
});

test('a hostile session id cannot escape the store', (t) => {
  const { root } = activeRepo(t);
  send(root, 'Stop.json', { session_id: '../../../evil' });
  assert.equal(fs.existsSync(path.join(root, 'evil-abcd1234.jsonl')), false);
  assert.equal(capturedEvents(root).length, 1);
});

test('from a subdirectory, events reach the same store', (t) => {
  const { root } = activeRepo(t);
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  send(nested, 'Stop.json');
  const [event] = capturedEvents(root);
  assert.equal(event.git.worktree, 'a/b');
});

test('from a linked worktree, events reach the same store', (t) => {
  const { root } = activeRepo(t);
  const wt = addWorktree(root, 'wt');
  send(wt, 'Stop.json');
  const [event] = capturedEvents(root);
  assert.equal(event.git.branch, 'wt-wt');
  assert.equal(fs.existsSync(path.join(wt, '.git', 'product-decisions')), false);
});

test('paths with spaces and accents work, for the repository and the plugin location', (t) => {
  const { root, base } = activeRepo(t, { dirName: 'Proyecto Año' });
  const plugin = copyPlugin(base, 'Plugin Ñ con espacios');
  const result = runHook({
    stdin: JSON.stringify(fixture('Stop.json', { cwd: root })),
    cwd: root,
    hookPath: path.join(plugin, 'scripts', 'hook.js'),
  });
  assertSilent(result);
  assert.equal(capturedEvents(root).length, 1);
});

test('a repository with no commits still captures', (t) => {
  const { root } = activeRepo(t, { commit: false });
  send(root, 'Stop.json');
  const [event] = capturedEvents(root);
  assert.equal(event.git.head, null);
  assert.equal(event.git.branch, 'main');
});

test('not activated: no file is created anywhere in the repository', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const before = walk(root).sort();
  send(root, 'Stop.json');
  assert.deepEqual(walk(root).sort(), before);
});

test('paused: no event is written, and no prompt text reaches any file under the store', (t) => {
  const { root } = activeRepo(t, undefined, { paused: true, paused_at: '2026-11-05T10:00:00+01:00' });
  send(root, 'UserPromptSubmit.json', { prompt: 'MARKER-DURING-PAUSE' });
  assert.equal(capturedEvents(root).length, 0);
  assert(!storeText(root).includes('MARKER-DURING-PAUSE'));
});

test('PRODUCT_DECISIONS_SYNTH=1: nothing is written', (t) => {
  const { root } = activeRepo(t);
  const before = walk(storeOf(root)).sort();
  const result = runHook({
    stdin: JSON.stringify(fixture('Stop.json', { cwd: root })),
    cwd: root,
    env: { PRODUCT_DECISIONS_SYNTH: '1' },
  });
  assertSilent(result);
  assert.deepEqual(walk(storeOf(root)).sort(), before);
});

test('a session file may begin with any event', (t) => {
  const { root } = activeRepo(t);
  send(root, 'PostToolUse-Read.json', { session_id: 'late' });
  const [event] = capturedEvents(root);
  assert.equal(event.event_type, 'tool_call');
  assert.equal(event.session_id, 'late');
  assert.equal(event.model, null);
});

test('the model from SessionStart reaches later main-agent events and not subagent events', (t) => {
  const { root } = activeRepo(t);
  const session_id = 'with-model';
  send(root, 'SessionStart-compact-model.json', { session_id });
  send(root, 'Stop.json', { session_id });
  send(root, 'PostToolUseFailure-Read-subagent.json', { session_id });
  const events = capturedEvents(root);
  assert.equal(events[0].model, 'claude-haiku-5-5');
  assert.equal(events[0].model_source, 'session_start');
  assert.equal(events[1].model, 'claude-haiku-5-5');
  assert.equal(events[2].agent.name, 'general-purpose');
  assert.equal(events[2].model, null);
});

test('a model switch updates later events', (t) => {
  const { root } = activeRepo(t);
  const session_id = 'switching';
  send(root, 'PostModelSwitch.json', { session_id });
  send(root, 'Stop.json', { session_id });
  const [, stop] = capturedEvents(root);
  assert.equal(stop.model, 'claude-sonnet-5-5');
  assert.equal(stop.model_source, 'model_switch');
});

test('a 9 MiB payload writes one event with payload.oversized true', (t) => {
  const { root } = activeRepo(t);
  send(root, 'PostToolUse-Read.json', { tool_response: 'MARKER'.repeat(1600000) });
  const [event] = capturedEvents(root);
  assert.equal(event.payload.oversized, true);
  assert(event.payload.bytes > 9 * 1024 * 1024);
  assert.equal(event.summary, 'Read');
  assert(!storeText(root).includes('MARKER'));
});

test('secrets from the corpus appear nowhere under the store', (t) => {
  const { root } = activeRepo(t);
  const all = corpus.map((entry) => entry.value).join(' ');
  send(root, 'UserPromptSubmit.json', { prompt: all });
  send(root, 'PostToolUse-Bash.json', { tool_input: { command: `curl ${all}` }, tool_response: { stdout: all } });
  send(root, 'PostToolUseFailure-Bash.json', { error: all });
  send(root, 'Stop.json', { last_assistant_message: all });
  const text = storeText(root);
  for (const { type, secret } of corpus) assert(!text.includes(secret), type);
  assert.equal(capturedEvents(root).length, 4);
});

test('summaries are built from redacted text', (t) => {
  const { root } = activeRepo(t);
  send(root, 'UserPromptSubmit.json', { prompt: corpus[3].value });
  const [event] = capturedEvents(root);
  assert.equal(event.summary, '[REDACTED:openai_key]');
});

test('personal redaction patterns apply', (t) => {
  const { root } = activeRepo(t, undefined, { redact_patterns: ['CLIENT-[0-9]+'] });
  send(root, 'UserPromptSubmit.json', { prompt: 'about CLIENT-77 today' });
  assert(!storeText(root).includes('CLIENT-77'));
});

test('Read of .env stores the path and hash only', (t) => {
  const { root } = activeRepo(t);
  send(root, 'PostToolUse-Read.json', { tool_input: { file_path: '.env' }, tool_response: 'plainvalue' });
  const [event] = capturedEvents(root);
  assert.equal(event.payload.tool_input.file_path, '.env');
  assert.equal(event.payload.tool_response.redacted_file, true);
  assert(!storeText(root).includes('plainvalue'));
});

test('latency is logged with no payload content', (t) => {
  const { root } = activeRepo(t);
  send(root, 'UserPromptSubmit.json', { prompt: 'MARKER-LATENCY' });
  const file = path.join(storeOf(root), 'logs', 'latency.jsonl');
  const record = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(record.tool, 'claude-code');
  assert.equal(record.event, 'UserPromptSubmit');
  assert(record.ms > 0);
  assert(!fs.readFileSync(file, 'utf8').includes('MARKER'));
});

test('errors are logged with no payload content', (t) => {
  const { root } = activeRepo(t);
  fs.writeFileSync(path.join(storeOf(root), 'raw'), 'not a directory');
  send(root, 'UserPromptSubmit.json', { prompt: 'MARKER-ERROR' });
  const log = fs.readFileSync(path.join(storeOf(root), 'logs', 'diagnostics.log'), 'utf8');
  const record = JSON.parse(log.trim().split('\n').pop());
  assert.equal(record.where, 'hook');
  assert(!log.includes('MARKER'));
});

test('invalid JSON is logged without quoting the input', (t) => {
  const { root } = activeRepo(t);
  assertSilent(runHook({ stdin: 'MARKER-INVALID-JSON{', cwd: root }));
  const log = fs.readFileSync(path.join(storeOf(root), 'logs', 'diagnostics.log'), 'utf8');
  assert(log.includes('SyntaxError'));
  assert(!log.includes('MARKER'));
});

test('capture leaves Git state alone in a repository with a dirty tree', (t) => {
  const { root } = activeRepo(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# Changed\n');
  const before = git(root, 'status', '--porcelain');
  send(root, 'Stop.json');
  assert.equal(git(root, 'status', '--porcelain'), before);
});
