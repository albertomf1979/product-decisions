'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { contentHash } = require('../plugin/src/core/event.js');
const { makeRepo, addWorktree, activate, git } = require('./helpers/repo.js');
const { factor, runHook, assertSilent, fixture, fixtureNames, storeOf, capturedEvents, storeText, recordText, copyPlugin, walk } = require('./helpers/hook-runner.js');
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

test('a failed command that read a secret file leaves no value anywhere', (t) => {
  const { root } = activeRepo(t);
  send(root, 'PostToolUseFailure-Bash.json', {
    tool_input: { command: 'cat .env && npm test' },
    error: 'Exit code 1\nDB_PASS=SENTINELvalue42',
  });
  assert(!storeText(root).includes('SENTINELvalue42'));
  assert.equal(capturedEvents(root).length, 1);
});

test('a shell write to a secret file leaves no value in the summary', (t) => {
  const { root } = activeRepo(t);
  send(root, 'PostToolUse-Bash.json', { tool_input: { command: 'echo DB_PASS=SENTINELvalue42 >> .env' } });
  const [event] = capturedEvents(root);
  assert.equal(event.summary, 'Bash');
  assert(!storeText(root).includes('SENTINELvalue42'));
});

test('a secret in a URL query does not reach the summary or the sources', (t) => {
  const { root } = activeRepo(t);
  send(root, 'PostToolUse-WebFetch.json', { tool_input: { url: 'https://example.com/x?api_key=SENTINELvalue42' } });
  const [event] = capturedEvents(root);
  assert(!event.summary.includes('SENTINEL'));
  assert(!JSON.stringify(event.sources).includes('SENTINEL'));
});

function runWithProject(root, project, cwd, name = 'Stop.json') {
  const payload = fixture(name, { cwd });
  assertSilent(runHook({
    stdin: JSON.stringify(payload),
    cwd: root,
    event: payload.hook_event_name,
    env: { CLAUDE_PROJECT_DIR: project },
  }));
}

test('a session that changes directory out of the repository stays captured', (t) => {
  const { root, base } = activeRepo(t);
  const outside = path.join(base, 'elsewhere');
  fs.mkdirSync(outside);
  runWithProject(root, root, outside);
  assert.equal(capturedEvents(root).length, 1);
});

test('a session that moves into a nested repository stays with its project', (t) => {
  const { root } = activeRepo(t);
  const nested = path.join(root, 'vendor', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q');
  runWithProject(root, root, nested);
  assert.equal(capturedEvents(root).length, 1);
  assert.equal(fs.existsSync(path.join(nested, '.git', 'product-decisions')), false);
});

test('the project repository governs: its pause holds when the session moves to another active repository', (t) => {
  const first = activeRepo(t, undefined, { paused: true, paused_at: 'x' });
  const second = activeRepo(t);
  runWithProject(first.root, first.root, second.root);
  assert.equal(capturedEvents(first.root).length, 0);
  assert.equal(capturedEvents(second.root).length, 0);
});

test('a session opened above the repository is captured once it moves in', (t) => {
  const { root, base } = activeRepo(t);
  runWithProject(root, base, root);
  assert.equal(capturedEvents(root).length, 1);
});

test('a project repository that is not activated does not swallow an activated one', (t) => {
  const { root: inactive, cleanup } = makeRepo();
  t.after(cleanup);
  const { root } = activeRepo(t);
  runWithProject(root, inactive, root);
  assert.equal(capturedEvents(root).length, 1);
  assert.equal(fs.existsSync(storeOf(inactive)), false);
});

const SIZE = Math.floor(3.9 * 1024 * 1024);
const fillTo = (unit) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

for (const [label, name, overrides] of [
  ['JWT-like text', 'PostToolUse-Read.json', { tool_response: fillTo('eyJaaaaaaaaaa-') }],
  ['repeated keywords', 'PostToolUse-Read.json', { tool_response: fillTo('SECRET_') }],
  ['repeated key headers', 'PostToolUse-Read.json', { tool_response: fillTo('-----BEGIN RSA PRIVATE KEY-----\n') }],
  ['dotted URLs in an MCP result', 'PostToolUse-mcp.json', { tool_response: Array(4).fill(`https://example.com/${'a.'.repeat(30000)}x`).join(' ') }],
]) {
  test(`${label} finish inside the watchdog budget`, (t) => {
    const { root } = activeRepo(t);
    const payload = fixture(name, { cwd: root, ...overrides });
    const result = runHook({ stdin: JSON.stringify(payload), cwd: root, event: 'PostToolUse' });
    assertSilent(result);
    assert(result.ms < 2000 * factor, `took ${result.ms.toFixed(0)} ms`);
    assert.equal(capturedEvents(root).length, 1);
  });
}

test('a huge structured payload is not parsed, and still leaves evidence', (t) => {
  const { root } = activeRepo(t);
  const head = JSON.stringify(fixture('PostToolUse-Read.json', { cwd: root, session_id: 'huge', tool_response: null })).slice(0, -1);
  const stdin = `${head},"filler":[${'{"a":1},'.repeat(8 * 1024 * 1024)}0]}`;
  const result = runHook({ stdin, cwd: root, event: 'PostToolUse' });
  assertSilent(result);
  assert(result.ms < 2000 * factor, `took ${result.ms.toFixed(0)} ms`);
  const [event] = capturedEvents(root);
  assert.equal(event.session_id, 'huge');
  assert.equal(event.event_type, 'tool_call');
  assert.equal(event.payload.oversized, true);
  assert.equal(event.summary, 'Read');
});

test('an ancestor package.json of type module does not stop capture', (t) => {
  const { root, base } = activeRepo(t);
  fs.mkdirSync(path.join(base, 'cache'));
  fs.writeFileSync(path.join(base, 'cache', 'package.json'), '{"type":"module"}\n');
  const plugin = copyPlugin(path.join(base, 'cache'), 'plugin');
  const result = runHook({
    stdin: JSON.stringify(fixture('Stop.json', { cwd: root })),
    cwd: root,
    hookPath: path.join(plugin, 'scripts', 'hook.js'),
  });
  assertSilent(result);
  assert.equal(capturedEvents(root).length, 1);
});

test('capture leaves Git state alone in a repository with a dirty tree', (t) => {
  const { root } = activeRepo(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# Changed\n');
  const before = git(root, 'status', '--porcelain');
  send(root, 'Stop.json');
  assert.equal(git(root, 'status', '--porcelain'), before);
});

function sendAs(root, { project, cwd, name, overrides = {}, env = {} }) {
  const payload = fixture(name, { cwd, ...overrides });
  assertSilent(runHook({
    stdin: JSON.stringify(payload),
    cwd,
    event: payload.hook_event_name,
    env: { CLAUDE_PROJECT_DIR: project, ...env },
  }));
}

test('a session opened above a repository sends tool events to the repository of the file', (t) => {
  const { root, base } = activeRepo(t);
  const edit = fixture('PostToolUse-Edit.json');
  sendAs(root, { project: base, cwd: base, name: 'PostToolUse-Edit.json', overrides: { tool_input: { ...edit.tool_input, file_path: path.join(root, 'a.js') } } });
  const events = capturedEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'tool_call');
});

test('that session records no prompt or response', (t) => {
  const { root, base } = activeRepo(t);
  sendAs(root, { project: base, cwd: base, name: 'UserPromptSubmit.json' });
  sendAs(root, { project: base, cwd: base, name: 'Stop.json' });
  assert.equal(capturedEvents(root).length, 0);
});

test('a file in a repository that is not activated captures nothing', (t) => {
  const { root, base, cleanup } = makeRepo();
  t.after(cleanup);
  const edit = fixture('PostToolUse-Edit.json');
  sendAs(root, { project: base, cwd: base, name: 'PostToolUse-Edit.json', overrides: { tool_input: { ...edit.tool_input, file_path: path.join(root, 'a.js') } } });
  assert.equal(fs.existsSync(storeOf(root)), false);
});

test('the home folder is masked everywhere in an event', (t) => {
  const { root, base } = activeRepo(t);
  const env = { HOME: base, USERPROFILE: base };
  sendAs(root, { project: root, cwd: root, name: 'SessionStart-startup.json', env, overrides: { transcript_path: path.join(base, '.claude', 't.jsonl') } });
  sendAs(root, { project: root, cwd: root, name: 'UserPromptSubmit.json', env, overrides: { prompt: `look at ${path.join(base, 'notes', 'x.md')}` } });
  sendAs(root, { project: root, cwd: root, name: 'PostToolUse-Read.json', env, overrides: { tool_input: { file_path: path.join(root, 'PRD.md') }, tool_response: `from ${base}` } });
  const events = capturedEvents(root);
  const byType = (type) => events.find((event) => event.event_type === type);
  assert.equal(events.length, 3);
  // The worker's local operational state keeps real paths; the record must not.
  assert(!recordText(root).includes(base), 'the real home path must not appear in the record');
  assert.equal(byType('session_start').sources[0].path, `~${path.sep}.claude${path.sep}t.jsonl`);
  assert(byType('user_prompt').payload.prompt.startsWith('look at ~'));
  assert.deepEqual(byType('tool_call').sources[0], { type: 'file', path: 'PRD.md', commit: byType('tool_call').git.head });
  assert.equal(byType('tool_call').summary, 'Read PRD.md');
});
