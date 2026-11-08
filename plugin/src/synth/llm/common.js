'use strict';

// Shared by ADRs and phase notes: dates, the session link, evidence, and sources.

const crypto = require('node:crypto');
const { code, escapeMarkdown } = require('../deterministic/excerpt.js');
const { t } = require('../deterministic/i18n.js');

/** The earliest evidence event: event ids sort by time. */
const firstOf = (ids, byId) => ids.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => (a.event_id < b.event_id ? -1 : 1))[0];

const day = (event) => String(event.timestamp).slice(0, 10).replace(/-/g, '');
const hash6 = (...parts) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 6);

/** `2026-11-05T10:42:17+01:00` → `2026-11-05 10:42 +01:00`. */
function when(timestamp) {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.exec(String(timestamp));
  return m ? `${m[1]} ${m[2]} ${m[3] === 'Z' ? '+00:00' : m[3]}` : String(timestamp);
}

const sessionLink = (session, lang, up) => `[${t(lang, 'session_word')} ${escapeMarkdown(String(session.id).slice(0, 8))}](${up}${session.file})`;
const evidenceLine = (ids) => ids.map((id) => `\`${id}\``).join(', ');

/** The deduplicated sources of the evidence events, as Markdown list items. */
function sourcesOf(ids, byId) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    for (const s of (byId.get(id) || {}).sources || []) {
      let line = null;
      if (s.type === 'file' && s.path) line = code(s.path);
      else if (['url', 'issue', 'pr'].includes(s.type) && s.url) line = code(s.url);
      else if (s.type === 'mcp' && s.server) line = `${code(s.server)} · ${code(s.tool)}`;
      if (line && !seen.has(line)) {
        seen.add(line);
        out.push(`- ${line}`);
      }
    }
  }
  return out;
}

module.exports = { firstOf, day, hash6, when, sessionLink, evidenceLine, sourcesOf };
