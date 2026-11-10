'use strict';

// The README's sample output (PRD section 9), rendered by the plugin's own renderers from a
// fictitious session. Ids, times, and the machine are fixed, so the output is the same on
// every system. To refresh the README after a renderer changes:
//   node tests/helpers/sample-output.js
// and paste the output between the sample markers.

const { buildEvent, contentHash } = require('../../plugin/src/core/event.js');
const { renderSession, sessionData } = require('../../plugin/src/synth/deterministic/session.js');
const { renderIndexes } = require('../../plugin/src/synth/deterministic/indexes.js');
const { adrFiles } = require('../../plugin/src/synth/llm/adr.js');
const { DEFAULT_CONFIG } = require('../../plugin/src/core/config.js');
const { CONSENT, CONSENT_SHA } = require('../../plugin/src/core/consent.js');

const SESSION = '7c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const MACHINE = 'a1b2c3d4';
const CONFIG = { ...DEFAULT_CONFIG, language: 'en' };
const GIT = { branch: 'main', head: '3f9a1c2b7d4e', worktree: '.', worktree_name: null };
const MODEL = 'claude-opus-5-5';

// [type, actor, payload, summary, sources, origin]
const STEPS = [
  ['session_start', 'user', { source: 'startup' }, 'Session started'],
  ['user_prompt', 'user', { prompt: 'Add a dark mode to the settings page.' }, 'Prompt: Add a dark mode to the settings page.'],
  ['tool_call', 'llm', { tool_input: { file_path: 'src/settings/Settings.tsx' } }, 'Read src/settings/Settings.tsx',
    [{ type: 'file', path: 'src/settings/Settings.tsx', commit: GIT.head }]],
  ['agent_response', 'llm', { last_assistant_message: 'Should the new theme start dark, light, or follow the system setting?' },
    'Response: Should the new theme start dark, light, or follow the system setting?'],
  ['user_prompt', 'user', { prompt: 'Follow the system setting by default, and keep a toggle to override it.' },
    'Prompt: Follow the system setting by default, and keep a toggle to override it.'],
  ['tool_call', 'llm', { tool_input: { file_path: 'src/theme/tokens.css' } }, 'Edit src/theme/tokens.css',
    [{ type: 'file', path: 'src/theme/tokens.css', commit: GIT.head }]],
  ['tool_call', 'llm', { tool_input: { file_path: 'src/settings/Settings.tsx' } }, 'Edit src/settings/Settings.tsx',
    [{ type: 'file', path: 'src/settings/Settings.tsx', commit: GIT.head }]],
  ['agent_response', 'llm', { last_assistant_message: 'Done: the theme follows the system setting, and the toggle overrides it.' },
    'Response: Done: the theme follows the system setting, and the toggle overrides it.'],
  ['file_changes', 'plugin', { key: 'k1', files: [
    { path: 'src/settings/Settings.tsx', status: 'modified', added: 18, removed: 2 },
    { path: 'src/theme/tokens.css', status: 'modified', added: 24, removed: 0 },
  ] }, '2 files changed', [], 'derived'],
  ['commit_linked', 'plugin', { sha: '8b2e4f6a1c3d5e7f9a0b2c4d6e8f0a1b2c3d4e5f', subject: 'Add a dark mode that follows the system setting', files: ['src/settings/Settings.tsx', 'src/theme/tokens.css'] },
    'Commit 8b2e4f6: Add a dark mode that follows the system setting', [], 'derived'],
  ['model_usage', 'plugin', { model: MODEL, tool_version: '2.1.310' }, `Model ${MODEL}`, [], 'derived'],
  ['session_end', 'user', { reason: 'other' }, 'Session ended'],
];

const pad = (n) => String(n).padStart(2, '0');

/** The fictitious session, as the record would hold it. */
function sampleEvents() {
  return STEPS.map(([eventType, actorType, payload, summary, sources = [], origin = 'hook'], i) => {
    const event = buildEvent(
      { eventType, actorType, llmName: 'claude', agent: { name: 'main' }, payload },
      {
        tool: 'claude-code', sessionId: SESSION, actorName: 'Ana', model: actorType === 'llm' ? MODEL : null,
        modelSource: actorType === 'llm' ? 'session_start' : null, git: GIT, sources, summary, origin, now: new Date(0),
      },
    );
    event.event_id = `01KA2B3C4D5E6F7G8H9J0K${pad(i + 1)}MN`;
    event.timestamp = `2026-11-03T10:${pad(i * 3)}:00.000+01:00`;
    event.content_hash = contentHash(event);
    return event;
  });
}

const DECISION = {
  title: 'Follow the system theme by default',
  decided_by: { type: 'user', name: 'Ana' },
  context: 'The settings page had no dark mode. Asked how the new theme should start, Ana chose its default.',
  decision: 'The theme follows the system setting until the person picks light or dark with the toggle.',
  alternatives: ['Start in light mode, as before', 'Start in dark mode'],
  consequences: 'People who never touch the toggle get the theme of their system. The dark colours live in tokens.css.',
  evidence: [],
  related: [],
  supersedes: [],
};

const fence = (body) => `\`\`\`\`markdown\n${body.trimEnd()}\n\`\`\`\``;

/** @returns {string} The Markdown that goes between the README's sample markers. */
function renderSample() {
  const events = sampleEvents();
  const data = sessionData(events, { machine: MACHINE });
  const files = new Map(renderSession(events, CONFIG, { machine: MACHINE }));
  const decision = { ...DECISION, evidence: [events[4].event_id] };
  for (const [file, content] of adrFiles(decision, { events, session: { id: SESSION, tool: 'claude-code', file: data.file }, lang: 'en' })) files.set(file, content);
  const adrData = JSON.parse([...files].find(([file]) => file.startsWith('.data/decisions/'))[1]);
  const consent = { schema_version: 1, machine: MACHINE, records: [{ at: '2026-11-03T09:58:00.000+01:00', actor: 'Ana', version: CONSENT_SHA.slice(0, 8), method: 'interactive' }], texts: { [CONSENT_SHA.slice(0, 8)]: CONSENT } };
  for (const [file, content] of renderIndexes([data], [], CONFIG, { decisions: [adrData], consents: [consent] })) files.set(file, content);

  const visible = [...files.keys()].filter((file) => !file.startsWith('.data/')).sort();
  const pick = (prefix) => files.get(visible.find((file) => file.startsWith(prefix)));
  return [
    'The folder, after one session with one decision:',
    '',
    '```text',
    'product-decisions/',
    ...visible.map((file) => `  ${file}`),
    '```',
    '',
    '`README.md`, the living index:',
    '',
    fence(pick('README.md')),
    '',
    'The session chronicle, in `timeline/`:',
    '',
    fence(pick('timeline/')),
    '',
    'A decision record, in `decisions/`. Only LLM synthesis writes these, and every one cites the events it rests on:',
    '',
    fence(pick('decisions/ADR-')),
  ].join('\n');
}

module.exports = { renderSample, sampleEvents };

if (require.main === module) process.stdout.write(`${renderSample()}\n`);
