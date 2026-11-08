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
  // Annotations are JSON Lines data, regenerated like the indexes; only Markdown carries the header.
  for (const [file, text] of renderIndexes([sessionData(fullSession(), context)], [], DEFAULT_CONFIG)) if (file.endsWith('.md')) assert.match(text, /do not edit/i);
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

test('the chronicle shows intermediate text and transcript denials, labelled as such', () => {
  n = 0;
  const events = [
    ev('session_start', { actorType: 'user', payload: { source: 'startup' } }),
    ev('agent_response', { origin: 'derived', payload: { last_assistant_message: 'Reading the PRD first.', intermediate: true, source: 'transcript' } }),
    ev('tool_denied', { actorType: 'user', origin: 'derived', payload: { tool_use_id: 't1', source: 'transcript' } }),
  ];
  const chronicle = [...renderSession(events, DEFAULT_CONFIG, context).values()][0];
  assert.match(chronicle, /Intermediate text: Reading the PRD first\./);
  assert.match(chronicle, /Tool call denied \(from the transcript\)/);
  const es = [...renderSession(events, { ...DEFAULT_CONFIG, language: 'es' }, context).values()][0];
  assert.match(es, /Texto intermedio: Reading the PRD first\./);
  assert.match(es, /Llamada denegada \(según la transcripción\)/);
});

test('the chronicle orders events by time, even when derived ones were appended later', () => {
  n = 0;
  const start = ev('session_start', { actorType: 'user', payload: { source: 'startup' } });
  const response = ev('agent_response', { payload: { last_assistant_message: 'FINAL-ANSWER' } });
  const early = { ...ev('agent_response', { origin: 'derived', payload: { last_assistant_message: 'EARLY-THOUGHT', intermediate: true, source: 'transcript' } }), timestamp: new Date(Date.parse(response.timestamp) - 500).toISOString() };
  const chronicle = [...renderSession([start, response, early], DEFAULT_CONFIG, context).values()][0];
  assert.ok(chronicle.indexOf('EARLY-THOUGHT') < chronicle.indexOf('FINAL-ANSWER'));
});

test('the coverage note says what comes from the transcript', () => {
  assert.match(tr('en', 'coverage_claude-code'), /transcript/);
  assert.match(tr('es', 'coverage_claude-code'), /transcripción/);
});

const decisionData = (id, at, extra = {}) => ({
  schema_version: 1, id, title: `Title ${id}`, file: `decisions/${id}-title.md`, at, session: 's-1234567890', session_file: 'timeline/x.md',
  tool: 'claude-code', decided_by: { type: 'user', name: 'Ana' }, evidence: ['01KAAAAAAAAAAAAAAAAAAA0001'], related: [], supersedes: [], ...extra,
});
const noteData = (phase, folder, extra = {}) => ({
  schema_version: 1, id: '20261105-abcdef', phase, title: `Note ${phase}`, file: `${folder}/notes/20261105-abcdef-note.md`, at: '2026-11-05T10:00:00+01:00',
  session: 's-1234567890', session_file: 'timeline/x.md', evidence: ['01KAAAAAAAAAAAAAAAAAAA0001'], ...extra,
});

test('the README lists decisions in order and links each one', () => {
  const a = decisionData('ADR-20261105-aaaaaa', '2026-11-05T12:00:00+01:00');
  const b = decisionData('ADR-20261105-bbbbbb', '2026-11-05T09:00:00+01:00');
  const readme = renderIndexes([sessionData(fullSession(), context)], [], DEFAULT_CONFIG, { decisions: [a, b] }).get('README.md');
  assert.match(readme, /## Decisions\n\n\| When \| ADR \| Decided by \|/);
  assert.ok(readme.indexOf('ADR-20261105-bbbbbb') < readme.indexOf('ADR-20261105-aaaaaa'));
  assert.ok(readme.includes('[ADR-20261105-aaaaaa](decisions/ADR-20261105-aaaaaa-title.md)'));
  assert.ok(!/There are none yet/.test(readme));
});

test('without decisions the README says they come from LLM synthesis', () => {
  const readme = renderIndexes([sessionData(fullSession(), context)], [], DEFAULT_CONFIG).get('README.md');
  assert.match(readme, /Decisions and phase notes are written by LLM synthesis after sessions close\. There are none yet, or synthesis is off\./);
  const es = renderIndexes([sessionData(fullSession(), context)], [], { ...DEFAULT_CONFIG, language: 'es' }).get('README.md');
  assert.match(es, /Las decisiones y las notas de fase las escribe la síntesis con LLM al cerrar cada sesión\. Todavía no hay ninguna, o la síntesis está desactivada\./);
});

test('decisions/README.md marks a superseded decision with the one that replaced it', () => {
  const old = decisionData('ADR-20261101-aaaaaa', '2026-11-01T10:00:00+01:00');
  const next = decisionData('ADR-20261105-bbbbbb', '2026-11-05T10:00:00+01:00', { supersedes: ['ADR-20261101-aaaaaa'] });
  const index = renderIndexes([], [], DEFAULT_CONFIG, { decisions: [next, old] }).get('decisions/README.md');
  assert.match(index, /^# Decisions\n\n> Generated by product-decisions/);
  assert.match(index, /ADR-20261101-aaaaaa.*Superseded by \[ADR-20261105-bbbbbb\]\(ADR-20261105-bbbbbb-title\.md\)/);
  assert.match(index, /ADR-20261105-bbbbbb.*Accepted \(inferred\)/);
  assert.equal(renderIndexes([], [], DEFAULT_CONFIG).get('decisions/README.md'), undefined);
});

test('a phase view exists only for phases with notes, and the README links it', () => {
  const files = renderIndexes([], [], DEFAULT_CONFIG, { notes: [noteData('design', '02-design')] });
  assert.match(files.get('02-design/README.md'), /^# Design\n\n> Generated by product-decisions/);
  assert.ok(files.get('02-design/README.md').includes('[Note design](notes/20261105-abcdef-note.md)'));
  assert.equal(files.get('04-release/README.md'), undefined);
  assert.ok(files.get('README.md').includes('[Design](02-design/README.md)'));
});

test('annotations combine rule labels and LLM labels per session', () => {
  const data = sessionData(fullSession(), context);
  const base = data.file.replace(/^timeline\//, '').replace(/\.md$/, '');
  const docChange = { at: '2026-11-05T10:00:00+01:00', path: 'PRD.md', actor: 'Ana', file: '01-definition/changes/x.md', session: data.session };
  const note = noteData('design', '02-design', { session: data.session, session_file: data.file });
  const lines = renderIndexes([data], [docChange], DEFAULT_CONFIG, { notes: [note] }).get(`annotations/${base}.jsonl`).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { phase: 'definition', source: 'rule', evidence: [] },
    { phase: 'design', source: 'llm', evidence: note.evidence, note: note.file },
    { phase: 'development', source: 'rule', evidence: [] },
  ]);
});

test('a session with nothing to label gets no annotations file', () => {
  n = 0;
  const quiet = sessionData([ev('session_start', { actorType: 'user', payload: { source: 'startup' } }), ev('user_prompt', { actorType: 'user', payload: { prompt: 'hi' } })], context);
  assert.ok(![...renderIndexes([quiet], [], DEFAULT_CONFIG).keys()].some((k) => k.startsWith('annotations/')));
});

test('the Codex coverage note says what hooks miss and that Codex support is pending review', () => {
  assert.match(tr('en', 'coverage_codex'), /hosted tools such as web search/i);
  assert.match(tr('en', 'coverage_codex'), /pending review/);
  assert.match(tr('es', 'coverage_codex'), /pendiente de revisión/);
});

test('PostModelRequest token usage appears in the chronicle as model use', () => {
  n = 0;
  const events = [
    ev('session_start', { actorType: 'user', payload: { source: 'startup' }, tool: 'codex' }),
    ev('model_usage', { payload: { model: 'gpt-5-codex', status: 'ok', token_usage: { input_tokens: 10, output_tokens: 2 } }, tool: 'codex' }),
  ];
  const chronicle = [...renderSession(events, DEFAULT_CONFIG, context).values()][0];
  assert.match(chronicle, /Model in use: gpt-5-codex/);
  assert.match(chronicle, /pending review/);
});

const consentData = (machine, records, texts) => ({ schema_version: 1, machine, records, texts });

test('the README lists who accepted which consent text, and when', () => {
  const consents = [
    consentData('bbbb2222', [{ at: '2026-11-08T12:00:00+01:00', actor: 'Ben', version: 'abcdef12', method: 'flag' }], { abcdef12: 'Text B' }),
    consentData('aaaa1111', [{ at: '2026-11-08T09:00:00+01:00', actor: 'Ana', version: 'abcdef12', method: 'interactive' }], { abcdef12: 'Text B' }),
  ];
  const files = renderIndexes([], [], DEFAULT_CONFIG, { consents });
  const readme = files.get('README.md');
  assert.match(readme, /## Consent\n\n\| Person \| Accepted \| Text \| How \|/);
  assert.ok(readme.indexOf('Ana') < readme.indexOf('Ben'));
  assert.ok(readme.includes('[abcdef12](consent/abcdef12.md)'));
  const es = renderIndexes([], [], { ...DEFAULT_CONFIG, language: 'es' }, { consents }).get('README.md');
  assert.match(es, /## Consentimiento/);
});

test('each consent text appears once per version, with the generated header', () => {
  const consents = [
    consentData('aaaa1111', [{ at: '2026-11-08T09:00:00+01:00', actor: 'Ana', version: 'abcdef12', method: 'flag' }, { at: '2026-11-08T10:00:00+01:00', actor: 'Ana', version: '12345678', method: 'flag' }], { abcdef12: 'First text', 12345678: 'Second text' }),
    consentData('bbbb2222', [{ at: '2026-11-08T11:00:00+01:00', actor: 'Ben', version: 'abcdef12', method: 'flag' }], { abcdef12: 'First text' }),
  ];
  const files = renderIndexes([], [], DEFAULT_CONFIG, { consents });
  assert.deepEqual([...files.keys()].filter((k) => k.startsWith('consent/')).sort(), ['consent/12345678.md', 'consent/abcdef12.md']);
  assert.match(files.get('consent/abcdef12.md'), /Generated by product-decisions/);
  assert.match(files.get('consent/abcdef12.md'), /First text/);
});

test('without consent records the README has no consent section', () => {
  assert.ok(!/## Consent/.test(renderIndexes([], [], DEFAULT_CONFIG).get('README.md')));
});
