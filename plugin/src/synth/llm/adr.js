'use strict';

// ADRs in Michael Nygard's format plus who decided, when, evidence, and sources (PRD
// LLM-7), with time-ordered ids from their first evidence event (LLM-8). Create-once.

const { escapeMarkdown } = require('../deterministic/excerpt.js');
const { t } = require('../deterministic/i18n.js');
const { sanitizeProse, sanitizeLine, slugify } = require('./prose.js');
const { firstOf, day, hash6, when, sessionLink, evidenceLine, sourcesOf } = require('./common.js');

/** @returns {string} `ADR-YYYYMMDD-xxxxxx`, stable for the same first event and title. */
const adrId = (firstEvent, title) => `ADR-${day(firstEvent)}-${hash6(firstEvent.event_id, title)}`;

function linkList(ids, known, lang) {
  if (ids.length === 0) return t(lang, 'none_lower');
  return ids.map((id) => (known.has(id) ? `[${id}](${known.get(id).replace(/^decisions\//, '')})` : id)).join(', ');
}

/**
 * @param {object} decision A checked decision (schema.js).
 * @param {{ events: object[], session: { id: string, tool: string, file: string }, lang: string, extra?: RegExp[], home?: string | null, known?: Map<string, string> }} ctx
 * @returns {Map<string, string>} The ADR and its data file.
 */
function adrFiles(decision, { events, session, lang, extra = [], home = null, known = new Map() }) {
  const byId = new Map(events.map((e) => [e.event_id, e]));
  const safe = (text) => sanitizeProse(text, { extra, home });
  const title = sanitizeLine(decision.title, { extra, home });
  const first = firstOf(decision.evidence, byId);
  const id = adrId(first, title);
  const file = `decisions/${id}-${slugify(title)}.md`;
  const alternatives = decision.alternatives.map((a) => `- ${sanitizeLine(a, { extra, home })}`);
  const sources = sourcesOf(decision.evidence, byId);
  const lines = [
    `# ${id}: ${title}`, '', `> ${t(lang, 'adr_note')}`, '',
    `- **${t(lang, 'status')}:** ${t(lang, 'status_inferred')}`,
    `- **${t(lang, 'decided_by')}:** ${t(lang, `actor_${decision.decided_by.type}`)}, ${escapeMarkdown(decision.decided_by.name)}`,
    `- **${t(lang, 'when')}:** ${when(first.timestamp)}, ${sessionLink(session, lang, '../')}`,
    `- **${t(lang, 'evidence')}:** ${evidenceLine(decision.evidence)}`,
    `- **${t(lang, 'related')}:** ${linkList(decision.related, known, lang)}`,
    ...(decision.supersedes.length ? [`- **${t(lang, 'supersedes')}:** ${linkList(decision.supersedes, known, lang)}`] : []),
    '', `## ${t(lang, 'context')}`, '', safe(decision.context),
    '', `## ${t(lang, 'decision_heading')}`, '', safe(decision.decision),
    '', `## ${t(lang, 'alternatives')}`, '', ...(alternatives.length ? alternatives : [t(lang, 'no_alternatives')]),
    '', `## ${t(lang, 'consequences')}`, '', safe(decision.consequences),
    '', `## ${t(lang, 'sources')}`, '', ...(sources.length ? sources : [t(lang, 'no_sources')]), '',
  ];
  const data = {
    schema_version: 1, id, title, file, at: first.timestamp, session: session.id, session_file: session.file, tool: session.tool,
    decided_by: decision.decided_by, evidence: decision.evidence, related: decision.related, supersedes: decision.supersedes,
  };
  return new Map([[file, lines.join('\n')], [`.data/decisions/${id}.json`, `${JSON.stringify(data, null, 2)}\n`]]);
}

module.exports = { adrId, adrFiles };
