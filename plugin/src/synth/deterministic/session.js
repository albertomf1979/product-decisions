'use strict';

// One session's chronicle and its machine-readable data. Indexes read only the data
// files, so they work for teammates' sessions and in public repositories.

const { excerpt, escapeMarkdown, code } = require('./excerpt.js');
const { t } = require('./i18n.js');
const { maskHome } = require('../../core/redact.js');

/** Masks the home folder in every string, keys included: older events may predate masking at capture. */
function maskDeep(value, home) {
  if (typeof value === 'string') return maskHome(value, home);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, home));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskHome(k, home), maskDeep(v, home)]));
}

const TOOL_EVENTS = new Set(['tool_call', 'tool_failure', 'tool_denied']);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (values) => [...new Set(values.filter(Boolean))].sort(byText);
const timeOf = (timestamp) => String(timestamp).slice(11, 19);

function baseName(events, machine) {
  const first = events[0];
  // The whole session id: two sessions on one machine may share any prefix.
  const session = String(first.session_id).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${String(first.timestamp).slice(0, 10)}-${first.tool}-${session}-${machine}`;
}

function aggregateSources(events) {
  const found = new Map();
  for (const event of events) {
    for (const source of event.sources || []) {
      if (source.type === 'transcript') continue; // local to one machine
      const { commit: _commit, ...identity } = source;
      const key = JSON.stringify(identity);
      if (!found.has(key)) found.set(key, { ...identity, event_ids: [] });
      const entry = found.get(key);
      if (entry.event_ids.length < 5) entry.event_ids.push(event.event_id);
    }
  }
  return [...found.values()].sort((a, b) => byText(JSON.stringify(a), JSON.stringify(b)));
}

/** @returns {object} The session's data: what the indexes are built from. */
function sessionData(events, { machine }) {
  const captured = events.filter((e) => e.origin !== 'derived' && e.event_type !== 'seal');
  const end = [...events].reverse().find((e) => e.event_type === 'session_end');
  const files = new Map();
  for (const event of events.filter((e) => e.event_type === 'file_changes')) {
    for (const file of event.payload.files || []) files.set(file.path, file);
  }
  const name = baseName(events, machine);
  return {
    schema_version: 1,
    tool: events[0].tool,
    session: events[0].session_id,
    machine,
    file: `timeline/${name}.md`,
    started: (captured[0] || events[0]).timestamp,
    ended: end ? end.timestamp : null,
    actors: unique(captured.filter((e) => e.actor && e.actor.type !== 'plugin').map((e) => `${e.actor.type}:${e.actor.name}`))
      .map((pair) => ({ type: pair.split(':')[0], name: pair.slice(pair.indexOf(':') + 1) })),
    models: unique([...events.map((e) => e.model), ...events.filter((e) => e.event_type === 'model_usage').map((e) => e.payload.model)]),
    event_count: captured.length,
    derived_count: events.length - captured.length,
    files: [...files.values()].sort((a, b) => byText(a.path, b.path)),
    commits: events.filter((e) => e.event_type === 'commit_linked').map((e) => e.payload),
    sources: aggregateSources(captured),
    partial: captured.some((e) => TOOL_EVENTS.has(e.event_type)) && !captured.some((e) => e.event_type === 'user_prompt'),
  };
}

function actorLabel(event) {
  const actor = event.actor || {};
  if (actor.type === 'subagent') return `subagent ${actor.name}`;
  return actor.name || actor.type || '';
}

function lineFor(event, lang) {
  const p = event.payload || {};
  switch (event.event_type) {
    case 'session_start': return t(lang, 'session_start', { source: p.source });
    case 'session_end': return t(lang, 'session_end', { reason: p.reason });
    case 'user_prompt': return `${t(lang, 'prompt')}: ${excerpt(p.prompt)}`;
    case 'agent_response': return `${t(lang, p.intermediate ? 'intermediate' : 'response')}: ${excerpt(p.last_assistant_message)}`;
    case 'tool_denied': return p.source === 'transcript' ? t(lang, 'denied_transcript') : excerpt(event.summary);
    case 'subagent_start': return t(lang, 'subagent_start', { name: escapeMarkdown(event.agent.name) });
    case 'subagent_stop': return t(lang, 'subagent_stop', { name: escapeMarkdown(event.agent.name) });
    case 'compaction': return t(lang, 'compaction', { stage: p.stage, trigger: p.trigger });
    case 'model_change': return t(lang, 'model_change', { model: p.to_model });
    case 'model_usage': return t(lang, 'model_usage', { model: p.model });
    case 'file_changes': return t(lang, 'file_changes', { count: (p.files || []).length });
    case 'commit_linked': return t(lang, 'commit', { sha: String(p.sha).slice(0, 7), subject: excerpt(p.subject, 120) });
    case 'consent': return t(lang, 'consent');
    default: return excerpt(event.summary);
  }
}

function renderMarkdown(events, data, config, gaps) {
  const lang = config.language;
  const out = [
    `# ${t(lang, 'session_title', { date: data.started.slice(0, 10), tool: data.tool, session: String(data.session).slice(0, 8) })}`,
    '',
    `> ${t(lang, 'generated_chronicle')}`,
    '',
    `- **${t(lang, 'started')}:** ${data.started}`,
    `- **${t(lang, 'ended')}:** ${data.ended || t(lang, 'still_open')}`,
    `- **${t(lang, 'people')}:** ${data.actors.filter((a) => a.type === 'user').map((a) => escapeMarkdown(a.name)).join(', ') || t(lang, 'none')}`,
    `- **${t(lang, 'models')}:** ${data.models.join(', ') || t(lang, 'none')}`,
    `- **${t(lang, 'events')}:** ${data.event_count} (+${data.derived_count} ${t(lang, 'derived')})`,
    '',
  ];
  if (data.partial) out.push(`> ${t(lang, 'partial')}`, '');

  const entries = events
    .filter((e) => e.event_type !== 'seal')
    .map((e) => ({ at: e.timestamp, sort: `${new Date(e.timestamp).toISOString()} ${e.event_id}`, text: `${timeOf(e.timestamp)} · ${escapeMarkdown(actorLabel(e))} · ${lineFor(e, lang)} · \`${e.event_id}\`` }));
  for (const gap of gaps) {
    entries.push({ sort: `${new Date(gap.from).toISOString()} gap`, text: `${timeOf(gap.from)} · ${t(lang, 'gap', { from: gap.from, to: gap.to })}` });
  }
  entries.sort((a, b) => byText(a.sort, b.sort));
  out.push(`## ${t(lang, 'timeline')}`, '', ...entries.map((entry) => `- ${entry.text}`), '');

  if (data.files.length > 0) {
    out.push(`## ${t(lang, 'files_changed')}`, '', `| ${t(lang, 'file')} | ${t(lang, 'change')} | ${t(lang, 'lines')} |`, '|---|---|---|');
    for (const f of data.files) {
      const lines = f.added === null ? '' : `+${f.added} −${f.removed}`;
      out.push(`| ${code(f.path)} | ${t(lang, `status_${f.status}`)} | ${lines} |`);
    }
    out.push('');
  }
  if (data.commits.length > 0) {
    out.push(`## ${t(lang, 'commits')}`, '', ...data.commits.map((c) => `- \`${String(c.sha).slice(0, 7)}\` ${excerpt(c.subject, 120)}`), '');
  }
  out.push(`## ${t(lang, 'coverage_title')}`, '', coverageNote(lang, data.tool), '');
  return `${out.join('\n')}`;
}

function coverageNote(lang, tool) {
  const key = `coverage_${tool}`;
  const text = t(lang, key);
  return text === key ? t(lang, 'coverage_default') : text;
}

/**
 * @param {object[]} events Every event of one session on one machine, in file order.
 * @param {object} config The project config.
 * @param {{ machine: string, gaps?: Array<{ from: string, to: string }>, home?: string | null }} context
 * @returns {Map<string, string>} The chronicle and the session's data file.
 */
function renderSession(rawEvents, config, { machine, gaps = [], home = null }) {
  const events = home ? maskDeep(rawEvents, home) : rawEvents;
  const data = sessionData(events, { machine });
  const start = Date.parse(data.started);
  const end = data.ended ? Date.parse(data.ended) : Infinity;
  const inside = gaps.filter((gap) => Date.parse(gap.from) >= start && Date.parse(gap.from) <= end);
  const name = baseName(events, machine);
  return new Map([
    [`timeline/${name}.md`, `${renderMarkdown(events, data, config, inside)}\n`],
    [`.data/sessions/${name}.json`, `${JSON.stringify(data, null, 2)}\n`],
  ]);
}

module.exports = { sessionData, renderSession };
