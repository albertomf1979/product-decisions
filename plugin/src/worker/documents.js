'use strict';

// Tracks declared documents such as the PRD (PRD 8.9). It only ever reads them: changes
// are recorded in the plugin's own files, and the documents stay byte-identical.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { storeDir } = require('../core/state.js');
const { appendLine, rawFilePath } = require('../core/store.js');
const { buildEvent, formatTimestamp } = require('../core/event.js');
const { redactString, compileExtra } = require('../core/redact.js');
const { git } = require('../git/plumbing.js');
const { t } = require('../synth/deterministic/i18n.js');
const { code } = require('../synth/deterministic/excerpt.js');

const BINARY_EXTENSIONS = /\.(pdf|docx?|pptx?|xlsx?|odt|png|jpe?g|gif|webp|zip|key|pages|numbers)$/i;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const nameOf = (rel) => rel.split(/[\\/]/).join('--');
const knownDir = (commonDir) => path.join(storeDir(commonDir), 'state', 'documents');
const knownFile = (commonDir, rel) => path.join(knownDir(commonDir), sha256(rel).slice(0, 16));

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Remembers a document's current content, or that it is absent. */
function remember(commonDir, rel, content) {
  fs.mkdirSync(knownDir(commonDir), { recursive: true, mode: 0o700 });
  const file = knownFile(commonDir, rel);
  if (content === null) {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(`${file}.deleted`, '');
  } else {
    fs.writeFileSync(file, content, { mode: 0o600 });
    fs.rmSync(`${file}.deleted`, { force: true });
  }
}

/** @returns {Buffer | null | undefined} The last known content, null if it was absent, undefined if never seen. */
function known(commonDir, rel) {
  const file = knownFile(commonDir, rel);
  if (fs.existsSync(`${file}.deleted`)) return null;
  const content = readOrNull(file);
  return content === null ? undefined : content;
}

function writeOnce(file, content) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

/** Copies the document as it now stands, the "original" changes are measured against (DOC-3). */
function declareBaseline({ location, commonDir, path: rel, overlayDir }) {
  const content = readOrNull(path.join(location.mainRoot, rel));
  if (content === null) return;
  writeOnce(path.join(overlayDir, '01-definition', 'baseline', nameOf(rel)), content);
  remember(commonDir, rel, content);
}

const isBinary = (rel, ...contents) => BINARY_EXTENSIONS.test(rel)
  || contents.some((c) => c && c.subarray(0, 8000).includes(0));

function diffOf(location, commonDir, before, after) {
  const tmp = path.join(storeDir(commonDir), 'tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const a = path.join(tmp, `before-${process.pid}`);
  const b = path.join(tmp, `after-${process.pid}`);
  try {
    fs.writeFileSync(a, before || '');
    fs.writeFileSync(b, after || '');
    const out = git(['diff', '--no-index', '--no-color', '--unified=3', a, b], { cwd: location.mainRoot, allowFail: true }).stdout.toString('utf8');
    return out.split('\n').filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line)).join('\n').trimEnd();
  } finally {
    fs.rmSync(a, { force: true });
    fs.rmSync(b, { force: true });
  }
}

const normalizePath = (p) => String(p).split(/[\\/]/).join('/');

/** The captured actions on this document since its last recorded change. */
function actionsOn(rel, events) {
  let since = 0;
  events.forEach((event, i) => {
    if (event.event_type === 'document_change' && event.payload.path === rel) since = i + 1;
  });
  return events.slice(since).filter((event) => {
    const input = event.payload && event.payload.tool_input;
    if (!input || typeof input !== 'object') return false;
    return [input.file_path, input.path, input.notebook_path].some((p) => {
      if (typeof p !== 'string') return false;
      const value = normalizePath(p);
      return value === rel || value.endsWith(`/${rel}`);
    });
  });
}

function renderRecord({ lang, rel, at, status, job, actions, git: gitInfo, content, diff, binary }) {
  const last = actions[actions.length - 1];
  const fence = diff && diff.includes('```') ? '~~~~' : '```';
  const lines = [
    `# ${t(lang, 'doc_change_title', { path: rel })}`, '', `> ${t(lang, 'doc_change_note')}`, '',
    `- **${t(lang, 'when')}:** ${at}`,
    `- **${t(lang, 'change')}:** ${t(lang, `status_${status}`)}`,
    last
      ? `- **${t(lang, 'session')}:** ${code(job.sessionId)} (${job.tool})`
      : `- **${t(lang, 'session')}:** ${t(lang, 'outside_session')}`,
  ];
  if (last) lines.push(`- **${t(lang, 'by')}:** ${last.actor.name} (${last.actor.type})`);
  if (gitInfo) lines.push(`- **${t(lang, 'branch')}:** ${code(gitInfo.branch || 'detached')} ${gitInfo.head ? code(gitInfo.head) : ''}`.trimEnd());
  if (actions.length > 0) lines.push(`- **${t(lang, 'events')}:** ${actions.map((a) => code(a.event_id)).join(' ')}`);
  lines.push('');
  if (binary) lines.push(t(lang, 'binary_note'), '', `sha256: ${code(content ? sha256(content) : 'none')}`, '');
  else if (diff) lines.push(`${fence}diff`, diff, fence, '');
  return `${lines.join('\n')}\n`;
}

/**
 * Compares each tracked document with its last known content and records any change.
 * A document that cannot be read is skipped; the others are still checked.
 */
function checkDocuments({ location, commonDir, config, state, job, events, git: gitInfo, overlayDir, now = new Date() }) {
  const extra = compileExtra([...(state.redact_patterns || []), ...(config.redact_patterns || [])]);
  const home = os.homedir();
  for (const rel of config.tracked_documents || []) {
    try {
      const current = readOrNull(path.join(location.worktreeRoot, rel));
      const previous = known(commonDir, rel);
      if (previous === undefined) {
        remember(commonDir, rel, current);
        continue;
      }
      if (previous === null ? current === null : current !== null && previous.equals(current)) continue;

      const status = current === null ? 'deleted' : previous === null ? 'restored' : 'modified';
      const binary = isBinary(rel, previous, current);
      const diff = binary ? null : redactString(diffOf(location, commonDir, previous, current), extra, home);
      const actions = actionsOn(rel, events);
      const at = formatTimestamp(now);
      const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15);
      const hash8 = current === null ? 'deleted' : sha256(current).slice(0, 8);
      const base = `${stamp}-${hash8}-${nameOf(rel)}`;
      const recordPath = `01-definition/changes/${base}.md`;
      const last = actions[actions.length - 1];

      writeOnce(path.join(overlayDir, recordPath), renderRecord({
        lang: config.language, rel, at, status, job, actions, git: gitInfo, content: current, diff, binary,
      }));
      writeOnce(path.join(overlayDir, '.data', 'documents', `${base}.json`), `${JSON.stringify({
        at, path: rel, status, file: recordPath, session: last ? job.sessionId : null,
        actor: last ? last.actor.name : t(config.language, 'outside_session_short'), outside_session: !last,
      }, null, 2)}\n`);
      appendLine(rawFilePath(commonDir, job.tool, job.sessionId, state.machine), JSON.stringify(buildEvent(
        {
          eventType: 'document_change',
          actorType: 'plugin',
          agent: { name: 'main' },
          payload: { path: rel, status, file: recordPath, sha256: current ? sha256(current) : null, outside_session: !last, event_ids: actions.map((a) => a.event_id) },
        },
        { tool: job.tool, sessionId: job.sessionId, actorName: null, git: gitInfo, sources: [{ type: 'file', path: rel, commit: gitInfo ? gitInfo.head : null }], summary: `${rel} ${status}`, origin: 'derived', now },
      )));
      remember(commonDir, rel, current);
    } catch {
      // One unreadable document must not stop the others.
    }
  }
}

module.exports = { declareBaseline, checkDocuments, remember };
