'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildEvent } = require('../plugin/src/core/event.js');
const { sessionData, renderSession } = require('../plugin/src/synth/deterministic/session.js');
const { renderIndexes } = require('../plugin/src/synth/deterministic/indexes.js');
const { excerpt } = require('../plugin/src/synth/deterministic/excerpt.js');
const { DICTIONARY, t: tr } = require('../plugin/src/synth/deterministic/i18n.js');
const { DEFAULT_CONFIG } = require('../plugin/src/core/config.js');

const BASE = Date.parse('2026-11-05T10:00:00Z');
let n = 0;
function ev(eventType, { actorType = 'llm', agent = { name: 'main' }, payload = {}, summary = eventType, sources = [], origin = 'hook', model = null, session = 's-1234567890', tool = 'claude-code' } = {}) {
  n += 1;
  return buildEvent(
    { eventType, actorType, llmName: 'claude', agent, payload },
    { tool, sessionId: session, actorName: 'Ana', model, git: { branch: 'main', head: 'abc', worktree: '.' }, sources, summary, origin, now: new Date(BASE + n * 1000) },
  );
}

function fullSession(session = 's-1234567890') {
  n = 0;
  return [
    ev('session_start', { actorType: 'user', payload: { source: 'startup' }, session }),
    ev('user_prompt', { actorType: 'user', payload: { prompt: '<system-reminder>HIDDEN-REMINDER</system-reminder>Add a login page' }, session }),
    ev('tool_call', { payload: { tool_input: { file_path: 'src/login.js' }, tool_response: 'FULL-RESULT-TEXT' }, summary: 'Edit src/login.js', sources: [{ type: 'file', path: 'src/login.js', commit: 'abc' }], session }),
    ev('tool_call', { payload: { tool_input: { file_path: '.env' }, tool_response: { redacted_file: true, sha256: 'SECRETHASH0123' } }, summary: 'Read .env', session }),
    ev('subagent_start', { actorType: 'subagent', agent: { name: 'reviewer', id: 'a1' }, session }),
    ev('tool_call', { actorType: 'subagent', agent: { name: 'reviewer', id: 'a1' }, summary: 'WebFetch example.com/doc', sources: [{ type: 'url', url: 'https://example.com/doc' }, { type: 'issue', url: 'https://github.com/o/r/issues/7' }], session }),
    ev('subagent_stop', { actorType: 'subagent', agent: { name: 'reviewer', id: 'a1' }, session }),
    ev('tool_call', { summary: 'MCP github.create_issue', sources: [{ type: 'mcp', server: 'github', tool: 'create_issue' }], session }),
    ev('compaction', { payload: { stage: 'PreCompact', trigger: 'auto' }, session }),
    ev('agent_response', { payload: { last_assistant_message: 'Done. The page is ready.' }, session }),
    ev('file_changes', { actorType: 'plugin', origin: 'derived', payload: { key: 'k', files: [{ path: 'src/login.js', status: 'modified', added: 12, removed: 3 }] }, session }),
    ev('commit_linked', { actorType: 'plugin', origin: 'derived', payload: { sha: 'f00dbabe1234567890', subject: 'Add login page', files: ['src/login.js'] }, session }),
    ev('model_usage', { actorType: 'plugin', origin: 'derived', payload: { model: 'claude-opus-5-5', tool_version: '2.1.310' }, session }),
    ev('session_end', { actorType: 'user', payload: { reason: 'other' }, session }),
  ];
}
const context = { machine: 'abcd1234', gaps: [{ from: new Date(BASE + 9500).toISOString(), to: new Date(BASE + 9800).toISOString() }] };
const chronicle = (events, config = DEFAULT_CONFIG, ctx = context) => {
  const files = renderSession(events, config, ctx);
  return [...files.entries()].find(([p]) => p.startsWith('timeline/'))[1];
};

test('two sessions whose ids share a prefix get different files', () => {
  const a = [...renderSession(fullSession('same-prefix-a'), DEFAULT_CONFIG, context).keys()];
  const b = [...renderSession(fullSession('same-prefix-b'), DEFAULT_CONFIG, context).keys()];
  assert.equal(a.filter((file) => b.includes(file)).length, 0);
});

test('rendering the same events twice is byte-identical', () => {
  const events = fullSession();
  assert.deepEqual([...renderSession(events, DEFAULT_CONFIG, context)], [...renderSession(events, DEFAULT_CONFIG, context)]);
});

test('it returns the chronicle and its data file, named by date, tool, session, and machine', () => {
  assert.deepEqual([...renderSession(fullSession(), DEFAULT_CONFIG, context).keys()].sort(), [
    '.data/sessions/2026-11-05-claude-code-s-1234567890-abcd1234.json',
    'timeline/2026-11-05-claude-code-s-1234567890-abcd1234.md',
  ]);
});

test('the order of input session data does not change the indexes', () => {
  const a = sessionData(fullSession('s-aaaaaaaaaa'), context);
  const b = sessionData(fullSession('s-bbbbbbbbbb'), context);
  assert.deepEqual([...renderIndexes([a, b], [], DEFAULT_CONFIG)], [...renderIndexes([b, a], [], DEFAULT_CONFIG)]);
});

test('the chronicle shows day, time, actors, models, tools, subagents, compactions, and gaps', () => {
  const text = chronicle(fullSession());
  for (const part of ['2026-11-05', 'Ana', 'claude-opus-5-5', 'Edit src/login.js', 'reviewer', 'PreCompact', 'auto', 'paused']) {
    assert(text.includes(part), part);
  }
});

test('prompts appear as short excerpts that link to their event id', () => {
  const events = fullSession();
  const text = chronicle(events);
  assert(text.includes('Add a login page'));
  assert(text.includes(events[1].event_id));
});

test('full tool results, system reminders, and secret-file hashes do not appear', () => {
  const text = chronicle(fullSession());
  assert(!text.includes('FULL-RESULT-TEXT'));
  assert(!text.includes('HIDDEN-REMINDER'));
  assert(!text.includes('system-reminder'));
  assert(text.includes('Read .env'));
  assert(!text.includes('SECRETHASH0123'));
});

test('coverage notes name what could not be observed for that tool', () => {
  assert.match(chronicle(fullSession()), /not observed/i);
});

test('a session with tool events and no prompts is marked partial and says why', () => {
  const events = fullSession().filter((e) => e.event_type !== 'user_prompt' && e.event_type !== 'agent_response');
  assert.equal(sessionData(events, context).partial, true);
  assert.match(chronicle(events), /partial/i);
  assert.equal(sessionData(fullSession(), context).partial, false);
});

test('a session with no end event is shown as open', () => {
  const events = fullSession().filter((e) => e.event_type !== 'session_end');
  assert.equal(sessionData(events, context).ended, null);
  assert.match(chronicle(events), /still open/i);
});

test('the model comes from derived events when the earlier events have none', () => {
  assert.deepEqual(sessionData(fullSession(), context).models, ['claude-opus-5-5']);
});

test('generated indexes carry the do-not-edit header, and chronicles say they grow by appending', () => {
  for (const [, text] of renderIndexes([sessionData(fullSession(), context)], [], DEFAULT_CONFIG)) assert.match(text, /do not edit/i);
  assert.match(chronicle(fullSession()), /grows/i);
});

test('English and Spanish both render, and every key exists in both', () => {
  assert.deepEqual(Object.keys(DICTIONARY.en).sort(), Object.keys(DICTIONARY.es).sort());
  const es = chronicle(fullSession(), { ...DEFAULT_CONFIG, language: 'es' });
  assert.match(es, /Sesión/);
  assert.notEqual(es, chronicle(fullSession()));
  assert.equal(tr('xx', 'events'), tr('en', 'events'));
});

test('the README links to every session and says plainly that decisions need LLM synthesis', () => {
  const data = [sessionData(fullSession('s-aaaaaaaaaa'), context), sessionData(fullSession('s-bbbbbbbbbb'), context)];
  const readme = renderIndexes(data, [], DEFAULT_CONFIG).get('README.md');
  for (const d of data) assert(readme.includes(`(${d.file})`), d.file);
  assert.match(readme, /LLM/);
});

test('the change index lists files with line counts and linked commits', () => {
  const changes = renderIndexes([sessionData(fullSession(), context)], [], DEFAULT_CONFIG).get('03-development/changes.md');
  assert(changes.includes('src/login.js'));
  assert(changes.includes('+12'));
  assert(changes.includes('−3') || changes.includes('-3'));
  assert(changes.includes('f00dbab'));
  assert(changes.includes('Add login page'));
});

test('the sources inventory groups files, URLs, MCP servers, issues, and PRs, each with event links', () => {
  const events = fullSession();
  const sources = renderIndexes([sessionData(events, context)], [], DEFAULT_CONFIG).get('sources/README.md');
  for (const part of ['src/login.js', 'https://example.com/doc', 'github', 'create_issue', 'https://github.com/o/r/issues/7']) assert(sources.includes(part), part);
  assert(sources.includes(events[2].event_id));
});

test('Markdown in a prompt excerpt cannot break the page', () => {
  const out = excerpt('line one\n# Heading\n```js\n</details> | col | <script>');
  assert(!out.includes('\n'));
  assert(!/(^|[^\\])`/.test(out));
  assert(!/(^|[^\\])</.test(out));
  assert(!/(^|[^\\])\|/.test(out));
});

test('excerpts are capped', () => {
  assert(excerpt('x'.repeat(1000)).length <= 280);
});

test('a turn renders the session into the folder', async (t) => {
  const { makeRepo, activate } = require('./helpers/repo.js');
  const { runCli } = require('./helpers/cli-runner.js');
  const { rawFilePath } = require('../plugin/src/core/store.js');
  const { runTurn } = require('../plugin/src/worker/turn.js');
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  assert.equal(runCli(['init', '--yes'], { cwd: root }).status, 0);
  const machine = JSON.parse(fs.readFileSync(path.join(root, '.git', 'product-decisions', 'local.json'), 'utf8')).machine;
  const file = rawFilePath(path.join(root, '.git'), 'claude-code', 's-1234567890', machine);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fullSession().filter((e) => e.origin !== 'derived').map((e) => `${JSON.stringify(e)}\n`).join(''));
  await runTurn({ kind: 'turn', tool: 'claude-code', sessionId: 's-1234567890', cwd: root, transcriptPath: null }, { commonDir: path.join(root, '.git') });
  const folder = path.join(root, 'product-decisions');
  assert(fs.readdirSync(path.join(folder, 'timeline')).some((f) => f.includes('s-123456')));
  assert(fs.readFileSync(path.join(folder, 'README.md'), 'utf8').includes('timeline/'));
  void activate;
});

test('the home folder is masked when rendering, even in events captured before masking existed', () => {
  const events = fullSession().map((e) => (e.event_type === 'tool_call' && e.summary === 'Edit src/login.js'
    ? { ...e, summary: 'Read /Users/someone/secret-project/a.md', sources: [{ type: 'file', path: '/Users/someone/secret-project/a.md', commit: 'abc' }] }
    : e));
  const files = renderSession(events, DEFAULT_CONFIG, { ...context, home: '/Users/someone' });
  for (const content of files.values()) assert(!content.includes('/Users/someone'), 'home must be masked');
  assert([...files.values()].join('').includes('~/secret-project/a.md'));
});
