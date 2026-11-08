'use strict';

// LLM synthesis in the worker (PRD 8.8): closed session ranges, once each, within the
// project's caps, written as create-once files by the plugin itself. Nothing is lost
// when a run cannot happen: the range stays pending and status says why.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLocal, storeDir } = require('../core/state.js');
const { readConfig, DEFAULT_CONFIG } = require('../core/config.js');
const { consentIsCurrent } = require('../core/consent.js');
const { locateStore } = require('../core/locate.js');
const { readSessionMeta } = require('../core/store.js');
const { formatTimestamp } = require('../core/event.js');
const { compileExtra } = require('../core/redact.js');
const { logError } = require('../core/diagnostics.js');
const { DOCS_REF, readRef } = require('../git/plumbing.js');
const { buildDocsFiles, overlayDir, walk, isDecisionData } = require('./render.js');
const { sessionData } = require('../synth/deterministic/session.js');
const { buildChunks, isWorthARun } = require('../synth/llm/input.js');
const { systemPrompt, promptHeader } = require('../synth/llm/prompt.js');
const { OUTPUT_SCHEMA, checkOutput } = require('../synth/llm/schema.js');
const { adrFiles } = require('../synth/llm/adr.js');
const { noteFiles } = require('../synth/llm/notes.js');
const { resolveClaude, runClaude } = require('../synth/llm/engine.js');
const { resolveCodex, runCodex } = require('../synth/llm/engine-codex.js');

/**
 * Failures that would repeat if retried as they are, and that may have spent quota: they
 * stop the run, and only an explicit sync --llm retries them.
 */
const REPEATING = new Set(['budget', 'no_output', 'timeout']);

/** A session whose last sealed turn is this old counts as closed, though its end was never seen. */
const IDLE_MS = 6 * 3600000;

/**
 * The caps each person consented to (the consent text quotes them). A shared config can
 * lower them but not raise them: anyone who can push the docs branch could otherwise
 * raise everyone's spending without notice.
 */
const CONSENTED = Object.freeze({
  max_runs_per_day: DEFAULT_CONFIG.llm.max_runs_per_day,
  max_budget_usd: DEFAULT_CONFIG.llm.max_budget_usd,
  max_input_chars: DEFAULT_CONFIG.llm.max_input_chars,
});
const effectiveLlm = (llm) => ({ ...llm, ...Object.fromEntries(Object.keys(CONSENTED).map((k) => [k, Math.min(llm[k], CONSENTED[k])])) });
const capsRaised = (llm) => Object.keys(CONSENTED).some((k) => llm[k] > CONSENTED[k]);

const statePath = (commonDir) => path.join(storeDir(commonDir), 'state', 'llm.json');
const EMPTY = () => ({ schema_version: 1, day: null, runs_today: 0, cursors: {}, failed: {}, last_run_at: null, last_error: null });

function readLlmState(commonDir) {
  try {
    const stored = JSON.parse(fs.readFileSync(statePath(commonDir), 'utf8'));
    return { ...EMPTY(), ...stored, cursors: { ...(stored.cursors || {}) }, failed: { ...(stored.failed || {}) } };
  } catch {
    return EMPTY();
  }
}

function writeLlmState(commonDir, value) {
  const file = statePath(commonDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readEvents(file) {
  return fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Every session of this machine with a closed part synthesis has not processed. A part is
 * closed by a close job, by an end event that was sealed, or by hours without activity
 * after a sealed turn (an end that never arrived, PRD CAP-5).
 */
function closedRanges(commonDir, state, llmState, now = new Date()) {
  const raw = path.join(storeDir(commonDir), 'raw');
  const out = [];
  for (const file of walk(raw).filter((f) => f.endsWith(`-${state.machine}.jsonl`) && path.basename(path.dirname(f)) !== 'cli').sort()) {
    const events = readEvents(file);
    if (events.length === 0) continue;
    const tool = path.basename(path.dirname(file));
    const sessionId = events[0].session_id;
    const key = `${tool}/${sessionId}`;
    const marked = (readSessionMeta(commonDir, tool, sessionId) || {}).closed_through;
    let end = marked ? events.findIndex((e) => e.event_id === marked) : -1;
    const last = lastCapturedIndex(events);
    if (last >= 0 && events[events.length - 1].event_type === 'seal') {
      const quiet = now.getTime() - Date.parse(events[last].timestamp) >= IDLE_MS;
      if (events[last].event_type === 'session_end' || quiet) end = Math.max(end, last);
    }
    if (end < 0) continue;
    const through = events[end].event_id;
    const cursor = llmState.cursors[key];
    const start = cursor ? events.findIndex((e) => e.event_id === cursor) + 1 : 0;
    const range = events.slice(start, end + 1);
    if (range.length === 0) continue;
    out.push({ tool, sessionId, file, key, events, range, through, worth: isWorthARun(range) });
  }
  return out;
}

function lastCapturedIndex(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].origin !== 'derived' && events[i].event_type !== 'seal') return i;
  return -1;
}

/** @returns {Array<{ tool, sessionId, file, key, from: string | null, through: string }>} Ranges worth a run that have not run. */
function pendingSessions(commonDir, { now = new Date() } = {}) {
  const state = readLocal(commonDir);
  if (!state || !state.activated) return [];
  return closedRanges(commonDir, state, readLlmState(commonDir), now).filter((r) => r.worth)
    .map((r) => ({ tool: r.tool, sessionId: r.sessionId, file: r.file, key: r.key, from: r.range[0].event_id, through: r.through }));
}

const today = (now) => formatTimestamp(now).slice(0, 10);

/** LLM use against the caps, for status. */
function llmStatus(commonDir, { now = new Date() } = {}) {
  const state = readLocal(commonDir);
  const config = readConfig(commonDir);
  const llm = readLlmState(commonDir);
  return {
    project_enabled: config.llm.enabled !== false,
    person_enabled: !state || state.llm_enabled !== false,
    consent_current: consentIsCurrent(state),
    model: config.llm.model,
    runs_today: llm.day === today(now) ? llm.runs_today : 0,
    max_runs_per_day: effectiveLlm(config.llm).max_runs_per_day,
    max_budget_usd: effectiveLlm(config.llm).max_budget_usd,
    caps_raised: capsRaised(config.llm),
    pending_sessions: pendingSessions(commonDir, { now }).length,
    last_run_at: llm.last_run_at,
    last_error: llm.last_error,
  };
}

/** Writes a file only if it does not exist yet. @returns {boolean} Whether it was written. */
function writeOnce(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/** The decisions already in the docs tree, as the model may link to them. */
function existingDecisions({ location, commonDir, state, config }) {
  if (!location) return [];
  const files = buildDocsFiles({ location, commonDir, state, config, bases: [readRef(location.mainRoot, DOCS_REF)] });
  const out = [];
  for (const [file, content] of files) {
    if (!file.startsWith('.data/decisions/')) continue;
    try {
      const data = JSON.parse(content.toString('utf8'));
      if (isDecisionData(data)) out.push({ id: data.id, title: data.title, at: data.at, file: data.file });
    } catch {
      // Skipped, as in the indexes.
    }
  }
  return out;
}

/**
 * The person's own agent, in an emptied work directory inside the store. With engine
 * "auto" it is the agent that ran the session (PRD LLM-11): claude -p for Claude Code,
 * codex exec for Codex (unverified, pending review).
 */
async function defaultEngine({ prompt, system, schema, config, commonDir, tool }) {
  const name = config.llm.engine === 'auto' ? (tool === 'codex' ? 'codex' : 'claude') : config.llm.engine;
  const bin = name === 'codex' ? resolveCodex() : resolveClaude();
  if (!bin) return { ok: false, reason: 'missing', detail: `${name} not found`, engine: name };
  const workDir = path.join(storeDir(commonDir), 'tmp', 'synth');
  fs.rmSync(workDir, { recursive: true, force: true });
  if (name === 'codex') return runCodex({ bin, prompt, system, schema, model: config.llm.model, workDir });
  return runClaude({ bin, prompt, system, schema, model: config.llm.model, maxBudgetUsd: config.llm.max_budget_usd, workDir });
}

const result = (status, extra = {}) => ({ status, runs: 0, decisions: 0, notes: 0, rejected: 0, pending: 0, error: null, ...extra });

/**
 * @returns {Promise<{ status: 'off' | 'no_consent' | 'nothing' | 'ran' | 'stopped', runs: number, decisions: number, notes: number, rejected: number, pending: number, error: { reason: string } | null }>}
 */
async function runSynthesis({ commonDir, force = false, now = new Date(), engine = defaultEngine, refresh = () => {}, refreshEveryMs = 60000, log = () => {} }) {
  const state = readLocal(commonDir);
  if (!state || !state.activated) return result('off');
  if (!consentIsCurrent(state)) return result('no_consent');
  const shared = readConfig(commonDir);
  const caps = effectiveLlm(shared.llm);
  const config = { ...shared, llm: caps };
  if (!force && (caps.enabled === false || state.llm_enabled === false || caps.max_runs_per_day === 0)) {
    return result('off', { pending: pendingSessions(commonDir, { now }).length });
  }

  const llm = readLlmState(commonDir);
  if (llm.day !== today(now)) Object.assign(llm, { day: today(now), runs_today: 0 });
  const location = locateStore(commonDir, state);
  const existing = existingDecisions({ location, commonDir, state, config });
  const existingIds = new Set(existing.map((d) => d.id));
  const known = new Map(existing.map((d) => [d.id, d.file]));
  const extra = compileExtra([...(state.redact_patterns || []), ...(config.redact_patterns || [])]);
  const home = os.homedir();
  const overlay = overlayDir(commonDir);
  const lang = config.language;
  const totals = { runs: 0, decisions: 0, notes: 0, rejected: 0 };
  let stopped = null;

  outer:
  for (const r of closedRanges(commonDir, state, llm, now)) {
    if (!r.worth) {
      llm.cursors[r.key] = r.through;
      writeLlmState(commonDir, llm);
      continue;
    }
    const header = promptHeader({ session: r.sessionId, tool: r.tool, language: lang, decisions: existing, maxChars: caps.max_input_chars });
    const chunks = buildChunks(r.range, { maxChars: caps.max_input_chars, header });
    if (!force && llm.failed[r.key] && llm.failed[r.key].from === chunks[0].from) continue;
    const session = { id: r.sessionId, tool: r.tool, file: sessionData(r.events, { machine: state.machine }).file };
    for (const chunk of chunks) {
      if (!force && llm.runs_today >= caps.max_runs_per_day) break outer;
      const timer = setInterval(refresh, refreshEveryMs);
      let outcome;
      try {
        outcome = await engine({ prompt: chunk.text, system: systemPrompt(lang), schema: OUTPUT_SCHEMA, config, commonDir, tool: r.tool });
      } finally {
        clearInterval(timer);
      }
      const at = formatTimestamp(now);
      if (!outcome || outcome.reason !== 'missing') {
        llm.runs_today += 1;
        llm.last_run_at = at;
      }
      if (outcome && outcome.ok) {
        totals.runs += 1;
        const checked = checkOutput(outcome.output, { events: r.events, existingIds });
        for (const decision of checked.decisions) {
          const files = adrFiles(decision, { events: r.events, session, lang, extra, home, known });
          const [adr] = [...files.keys()].filter((f) => f.startsWith('decisions/'));
          let wrote = false;
          for (const [file, content] of files) wrote = writeOnce(path.join(overlay, file), content) || wrote;
          if (wrote) {
            totals.decisions += 1;
            const data = JSON.parse([...files.values()][1]);
            existingIds.add(data.id);
            known.set(data.id, adr);
            existing.push({ id: data.id, title: data.title, at: data.at, file: adr });
          }
        }
        for (const note of checked.notes) {
          let wrote = false;
          for (const [file, content] of noteFiles(note, { events: r.events, session, lang, extra, home })) wrote = writeOnce(path.join(overlay, file), content) || wrote;
          if (wrote) totals.notes += 1;
        }
        if (checked.rejected.length > 0) {
          totals.rejected += checked.rejected.length;
          const err = Object.assign(new Error(`rejected ${checked.rejected.length}: ${[...new Set(checked.rejected.map((x) => `${x.kind} ${x.reason}`))].join(', ')}`), { code: 'REJECTED' });
          logError(commonDir, 'synthesis', err);
        }
        llm.cursors[r.key] = chunk.to;
        delete llm.failed[r.key];
        llm.last_error = null;
        writeLlmState(commonDir, llm);
        continue;
      }
      const reason = (outcome && outcome.reason) || 'exit';
      llm.last_error = { reason, at };
      log(Object.assign(new Error(`synthesis ${reason}`), { code: 'SYNTHESIS' }));
      // Any failure stops the run: a systematic cause must not spend a run on every session.
      if (REPEATING.has(reason)) llm.failed[r.key] = { from: chunk.from, reason, at };
      writeLlmState(commonDir, llm);
      stopped = reason === 'missing' && outcome && outcome.engine ? { reason, engine: outcome.engine } : { reason };
      break outer;
    }
  }

  if (totals.decisions + totals.notes > 0) require('./render.js').refreshFolder({ commonDir });
  const pending = pendingSessions(commonDir, { now }).length;
  if (stopped) return result('stopped', { ...totals, pending, error: stopped });
  return result(totals.runs > 0 ? 'ran' : 'nothing', { ...totals, pending });
}

module.exports = { runSynthesis, pendingSessions, llmStatus, readLlmState, defaultEngine, effectiveLlm };
