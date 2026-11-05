'use strict';

// P1 from the PRD: on every path a hook exits 0 and writes nothing to stdout or stderr.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRepo, activate } = require('./helpers/repo.js');
const { factor, runHook, runHookAsync, assertSilent, fixtureNames, fixture, storeOf, copyPlugin } = require('./helpers/hook-runner.js');

const asJson = (name, cwd) => JSON.stringify(fixture(name, { cwd }));
const eventOf = (name) => fixture(name).hook_event_name;

function activeRepo(t) {
  const repo = makeRepo();
  t.after(repo.cleanup);
  activate(repo.root);
  return repo;
}

test('every fixture, active repository', (t) => {
  const { root } = activeRepo(t);
  for (const name of fixtureNames()) {
    assertSilent(runHook({ stdin: asJson(name, root), cwd: root, event: eventOf(name) }), name);
  }
});

test('every fixture, repository not activated', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  for (const name of fixtureNames()) {
    assertSilent(runHook({ stdin: asJson(name, root), cwd: root, event: eventOf(name) }), name);
  }
});

test('every fixture, outside any repository', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-outside-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of fixtureNames()) {
    assertSilent(runHook({ stdin: asJson(name, dir), cwd: dir, event: eventOf(name) }), name);
  }
});

for (const [label, stdin] of Object.entries({
  'empty stdin': '',
  'invalid JSON': '{nope',
  'a JSON array': '[1,2]',
  'JSON null': 'null',
  'a JSON number': '42',
  'non-UTF-8 bytes': Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x7b]),
  'unknown hook event': JSON.stringify({ hook_event_name: 'Nope', session_id: 's' }),
  'a cwd that is not a string': JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: 5 }),
  'no session id': JSON.stringify({ hook_event_name: 'Stop' }),
})) {
  test(`${label}, active repository`, (t) => {
    const { root } = activeRepo(t);
    assertSilent(runHook({ stdin, cwd: root }), label);
  });
}

test('unknown tool argument', (t) => {
  const { root } = activeRepo(t);
  assertSilent(runHook({ stdin: asJson('Stop.json', root), cwd: root, tool: 'constructor' }));
});

test('no arguments', (t) => {
  const { root } = activeRepo(t);
  assertSilent(runHook({ stdin: asJson('Stop.json', root), cwd: root, args: [] }));
});

test('nonexistent cwd in the payload', (t) => {
  const { root } = activeRepo(t);
  assertSilent(runHook({ stdin: asJson('Stop.json', path.join(root, 'no', 'such', 'dir')), cwd: root }));
});

test('.git/product-decisions is a file, not a directory', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  fs.writeFileSync(storeOf(root), 'not a directory');
  assertSilent(runHook({ stdin: asJson('Stop.json', root), cwd: root }));
});

test('the raw folder is a file', (t) => {
  const { root } = activeRepo(t);
  fs.writeFileSync(path.join(storeOf(root), 'raw'), 'not a directory');
  assertSilent(runHook({ stdin: asJson('Stop.json', root), cwd: root }));
});

test('read-only store', { skip: process.platform === 'win32' }, (t) => {
  const { root } = activeRepo(t);
  fs.chmodSync(storeOf(root), 0o500);
  try {
    assertSilent(runHook({ stdin: asJson('Stop.json', root), cwd: root }));
  } finally {
    // Restored here, not in t.after, because cleanup needs write access and runs first.
    fs.chmodSync(storeOf(root), 0o700);
  }
});

test('a corrupt local state', (t) => {
  const { root } = activeRepo(t);
  fs.writeFileSync(path.join(storeOf(root), 'local.json'), '{broken');
  assertSilent(runHook({ stdin: asJson('Stop.json', root), cwd: root }));
});

test('invalid redaction patterns in the local state', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  activate(root, { redact_patterns: ['(unclosed', 7] });
  assertSilent(runHook({ stdin: asJson('Stop.json', root), cwd: root }));
});

test('a 9 MiB tool result', (t) => {
  const { root } = activeRepo(t);
  const stdin = JSON.stringify(fixture('PostToolUse-Read.json', { cwd: root, tool_response: 'x'.repeat(9 * 1024 * 1024) }));
  assertSilent(runHook({ stdin, cwd: root, event: 'PostToolUse' }));
});

test('a module throwing at load time still exits 0 silently', (t) => {
  const { root, base } = activeRepo(t);
  const plugin = copyPlugin(base, 'broken-plugin');
  fs.writeFileSync(path.join(plugin, 'src', 'hook', 'run.js'), "throw new Error('boom');\n");
  assertSilent(runHook({ stdin: asJson('Stop.json', root), cwd: root, hookPath: path.join(plugin, 'scripts', 'hook.js') }));
});

test('a module with a syntax error still exits 0 silently', (t) => {
  const { root, base } = activeRepo(t);
  const plugin = copyPlugin(base, 'broken-plugin');
  fs.writeFileSync(path.join(plugin, 'src', 'core', 'locate.js'), 'this is not javascript (((\n');
  assertSilent(runHook({ stdin: asJson('Stop.json', root), cwd: root, hookPath: path.join(plugin, 'scripts', 'hook.js') }));
});

test('stdin that never closes exits 0 within 2.5 seconds', async (t) => {
  const { root } = activeRepo(t);
  const result = await runHookAsync({ cwd: root, keepStdinOpen: true });
  assertSilent(result);
  assert(result.ms < 2500 * factor, `took ${result.ms.toFixed(0)} ms`);
});

test('SessionEnd with stdin that never closes exits 0 within 1.2 seconds', async (t) => {
  const { root } = activeRepo(t);
  const result = await runHookAsync({ cwd: root, event: 'SessionEnd', keepStdinOpen: true });
  assertSilent(result);
  assert(result.ms < 1200 * factor, `took ${result.ms.toFixed(0)} ms`);
});
