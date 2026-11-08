'use strict';

// Views rebuilt from every decision and phase note data file in the docs tree, plus the
// phase labels per session (PRD 8.3: phases live in annotations, not in raw events).

const { escapeMarkdown } = require('./excerpt.js');
const { t } = require('./i18n.js');
const { PHASES } = require('../llm/schema.js');
const { PHASE_FOLDERS } = require('../llm/notes.js');

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const shortWhen = (at) => String(at).slice(0, 16).replace('T', ' ');
const ordered = (items) => [...items].sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) || byText(a.id, b.id));
const decider = (d, lang) => `${t(lang, `actor_${d.decided_by.type}`)}, ${escapeMarkdown(d.decided_by.name)}`;
const local = (file) => file.replace(/^decisions\//, '');

/** The decision that replaced each superseded one: the latest, when several did. */
function replacements(decisions) {
  const map = new Map();
  for (const d of ordered(decisions)) for (const old of d.supersedes) map.set(old, d);
  return map;
}

function decisionsIndex(decisions, lang) {
  const replaced = replacements(decisions);
  const rows = ordered(decisions).map((d) => {
    const by = replaced.get(d.id);
    const status = by ? t(lang, 'superseded_by', { link: `[${by.id}](${local(by.file)})` }) : t(lang, 'status_inferred');
    return `| ${shortWhen(d.at)} | [${d.id}](${local(d.file)}) ${escapeMarkdown(d.title)} | ${decider(d, lang)} | ${status} |`;
  });
  return [
    `# ${t(lang, 'decisions')}`, '', `> ${t(lang, 'generated_index')}`, '',
    `| ${t(lang, 'when')} | ADR | ${t(lang, 'decided_by')} | ${t(lang, 'status')} |`, '|---|---|---|---|', ...rows, '',
  ].join('\n');
}

function phaseView(phase, notes, lang) {
  const folder = PHASE_FOLDERS[phase];
  const items = ordered(notes).map((n) => `- ${String(n.at).slice(0, 10)} · [${escapeMarkdown(n.title)}](${n.file.slice(folder.length + 1)})`);
  return [`# ${t(lang, `phase_${phase}`)}`, '', `> ${t(lang, 'generated_index')}`, '', ...items, ''].join('\n');
}

function annotations(session, notes, documentChanges) {
  const labels = [];
  if (documentChanges.some((c) => c.session === session.session)) labels.push({ phase: 'definition', source: 'rule', evidence: [] });
  if (session.files.length > 0 || session.commits.length > 0) labels.push({ phase: 'development', source: 'rule', evidence: [] });
  for (const n of notes.filter((x) => x.session === session.session && x.session_file === session.file)) {
    labels.push({ phase: n.phase, source: 'llm', evidence: n.evidence, note: n.file });
  }
  return labels.sort((a, b) => (PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase)) || byText(a.source, b.source) || byText(a.note || '', b.note || ''));
}

/** @returns {string[]} README lines for decisions and phase views. */
function readmeSection(decisions, notes, lang) {
  const out = [];
  if (decisions.length === 0) out.push(t(lang, 'readme_decisions'), '');
  else {
    out.push(`## ${t(lang, 'decisions')}`, '', `| ${t(lang, 'when')} | ADR | ${t(lang, 'decided_by')} |`, '|---|---|---|');
    for (const d of ordered(decisions)) out.push(`| ${shortWhen(d.at)} | [${d.id}](${d.file}) ${escapeMarkdown(d.title)} | ${decider(d, lang)} |`);
    out.push('');
  }
  const phases = PHASES.filter((p) => notes.some((n) => n.phase === p));
  if (phases.length > 0) out.push(`## ${t(lang, 'phases')}`, '', ...phases.map((p) => `- [${t(lang, `phase_${p}`)}](${PHASE_FOLDERS[p]}/README.md)`), '');
  return out;
}

/**
 * @returns {Map<string, string>} decisions/README.md, a README per phase with notes, and
 * annotations/<session>.jsonl for each session that has a label.
 */
function renderDecisionViews(decisions, notes, sessions, documentChanges, config) {
  const lang = config.language;
  const files = new Map();
  if (decisions.length > 0) files.set('decisions/README.md', decisionsIndex(decisions, lang));
  for (const phase of PHASES) {
    const own = notes.filter((n) => n.phase === phase);
    if (own.length > 0) files.set(`${PHASE_FOLDERS[phase]}/README.md`, phaseView(phase, own, lang));
  }
  for (const session of sessions) {
    const labels = annotations(session, notes, documentChanges);
    if (labels.length === 0) continue;
    const base = session.file.replace(/^timeline\//, '').replace(/\.md$/, '');
    files.set(`annotations/${base}.jsonl`, labels.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return files;
}

module.exports = { renderDecisionViews, readmeSection };
