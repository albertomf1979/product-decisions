'use strict';

// Phase notes: cited summaries in the phase folders, only where sessions hold material
// (PRD LLM-10). Create-once, like ADRs.

const { t } = require('../deterministic/i18n.js');
const { sanitizeProse, sanitizeLine, slugify } = require('./prose.js');
const { firstOf, day, hash6, when, sessionLink, evidenceLine } = require('./common.js');

const PHASE_FOLDERS = Object.freeze({
  discovery: '00-discovery', definition: '01-definition', design: '02-design',
  development: '03-development', release: '04-release', monitoring: '05-monitoring',
});

/**
 * @param {object} note A checked phase note (schema.js).
 * @returns {Map<string, string>} The note and its data file.
 */
function noteFiles(note, { events, session, lang, extra = [], home = null }) {
  const byId = new Map(events.map((e) => [e.event_id, e]));
  const title = sanitizeLine(note.title, { extra, home });
  const first = firstOf(note.evidence, byId);
  const id = `${day(first)}-${hash6(first.event_id, note.phase, title)}`;
  const file = `${PHASE_FOLDERS[note.phase]}/notes/${id}-${slugify(title, 'note')}.md`;
  const lines = [
    `# ${title}`, '', `> ${t(lang, 'adr_note')}`, '',
    `- **${t(lang, 'phase')}:** ${t(lang, `phase_${note.phase}`)}`,
    `- **${t(lang, 'when')}:** ${when(first.timestamp)}, ${sessionLink(session, lang, '../../')}`,
    `- **${t(lang, 'evidence')}:** ${evidenceLine(note.evidence)}`,
    '', sanitizeProse(note.summary, { extra, home }), '',
  ];
  const data = { schema_version: 1, id, phase: note.phase, title, file, at: first.timestamp, session: session.id, session_file: session.file, evidence: note.evidence };
  return new Map([[file, lines.join('\n')], [`.data/phases/${id}.json`, `${JSON.stringify(data, null, 2)}\n`]]);
}

module.exports = { noteFiles, PHASE_FOLDERS };
