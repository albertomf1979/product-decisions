'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readLocal, storeDir } = require('../core/state.js');
const { readConfig } = require('../core/config.js');
const { DOCS_REF, git, readRef } = require('../git/plumbing.js');
const { verifyFile } = require('../worker/seal.js');
const { requireRepo } = require('./shared.js');

const LATENCY_WINDOW = 1000;
const HINT_MARGIN_MS = 5 * 60 * 1000;
const TRACKING_REFS = ['refs/remotes/origin/product-decisions/docs', 'refs/product-decisions/remotes/raw'];

function walk(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  } catch {
    return [];
  }
}

/**
 * Calls `visit` for each complete line, reading in chunks so a huge file is never
 * loaded whole. A last line with no newline yet is still being written: skipped.
 */
function eachLine(file, visit) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  const chunk = Buffer.alloc(1024 * 1024);
  let rest = Buffer.alloc(0);
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const data = rest.length ? Buffer.concat([rest, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let start = 0;
      for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
        if (end > start) visit(data.toString('utf8', start, end));
        start = end + 1;
      }
      rest = Buffer.from(data.subarray(start));
    }
  } finally {
    fs.closeSync(fd);
  }
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** A log and its rotated predecessor, oldest first. */
function logRecords(file) {
  const records = [];
  for (const part of [`${file}.1`, file]) eachLine(part, (line) => { const r = parse(line); if (r) records.push(r); });
  return records;
}

function toolStats(store) {
  const rawDir = path.join(store, 'raw');
  const tools = {};
  let toolDirs = [];
  try {
    toolDirs = fs.readdirSync(rawDir);
  } catch {
    return tools;
  }
  for (const tool of toolDirs.filter((name) => name !== 'cli')) {
    const stats = { sessions: 0, events: 0, derived: 0, last_event_at: null };
    for (const file of walk(path.join(rawDir, tool))) {
      stats.sessions += 1;
      eachLine(file, (line) => {
        const event = parse(line);
        if (!event) return;
        // Captured events are what the hooks saw; derived ones are the worker's additions.
        if (event.origin === 'derived') {
          stats.derived += 1;
          return;
        }
        stats.events += 1;
        const at = event.timestamp;
        // Compared as instants, because timestamps can carry different offsets.
        if (at && (!stats.last_event_at || new Date(at) > new Date(stats.last_event_at))) stats.last_event_at = at;
      });
    }
    tools[tool] = stats;
  }
  return tools;
}

function latencyStats(store) {
  const values = logRecords(path.join(store, 'logs', 'latency.jsonl'))
    .slice(-LATENCY_WINDOW)
    .map((record) => record.ms)
    .filter((ms) => typeof ms === 'number')
    .sort((a, b) => a - b);
  const at = (q) => (values.length ? Number(values[Math.min(values.length - 1, Math.floor(values.length * q))].toFixed(1)) : null);
  return { count: values.length, p50: at(0.5), p95: at(0.95) };
}

function errorStats(store) {
  const records = logRecords(path.join(store, 'logs', 'diagnostics.log'));
  return { count: records.length, last_at: records.length ? records[records.length - 1].ts ?? null : null };
}

function gitVersion() {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^git version\s*/, '');
  } catch {
    return null;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function publishedBytes(cwd) {
  let total = 0;
  for (const ref of TRACKING_REFS) {
    const listing = git(['ls-tree', '-r', '-l', ref], { cwd, allowFail: true });
    if (listing.status !== 0) continue;
    for (const line of listing.stdout.toString('utf8').split('\n')) {
      const size = Number(line.split(/\s+/)[3]);
      if (Number.isFinite(size)) total += size;
    }
  }
  return total;
}

function sealStats(store, machine) {
  const stats = { sessions: 0, unsealed_events: 0, problems: 0 };
  if (!machine) return stats;
  for (const file of walk(path.join(store, 'raw')).filter((f) => f.endsWith(`-${machine}.jsonl`))) {
    const result = verifyFile(file);
    stats.sessions += 1;
    stats.unsealed_events += result.unsealed;
    stats.problems += result.problems.length;
  }
  return stats;
}

/** Makes silently missing capture visible: transcripts newer than anything captured. */
function captureHint(location, tools) {
  const { latestSessionAt } = require('../adapters/claude-code.js');
  const latest = latestSessionAt(location.mainRoot);
  if (!latest) return null;
  const captured = Object.values(tools).map((t) => t.last_event_at).filter(Boolean).map((at) => Date.parse(at));
  const last = captured.length ? Math.max(...captured) : 0;
  if (Date.parse(latest) - last <= HINT_MARGIN_MS) return null;
  return 'A Claude Code session ran here after the last captured event. If capture should be on, check that the plugin is installed and enabled for this folder.';
}

function collect(location) {
  const state = readLocal(location.commonDir);
  const store = storeDir(location.commonDir);
  const config = readConfig(location.commonDir);
  const bytes = walk(store).reduce((sum, file) => {
    try {
      return sum + fs.statSync(file).size;
    } catch {
      return sum;
    }
  }, 0);
  const tools = toolStats(store);
  const publication = readJson(path.join(store, 'state', 'publish.json'), {});
  const remoteNames = git(['remote'], { cwd: location.mainRoot, allowFail: true }).stdout.toString('utf8').split('\n').filter(Boolean);
  return {
    repo: { root: location.mainRoot },
    activated: Boolean(state && state.activated),
    paused: Boolean(state && state.paused),
    actor: state ? state.actor_name : null,
    project: {
      declared: Boolean(readRef(location.mainRoot, DOCS_REF)),
      folder: config.folder,
      language: config.language,
      tracked_documents: config.tracked_documents,
    },
    tools,
    store: { bytes },
    publication: {
      remote: remoteNames.includes('origin') ? 'origin' : remoteNames[0] || null,
      visibility: publication.visibility ?? null,
      docs_pending: Boolean(publication.docs_pending),
      raw_pending: Boolean(publication.raw_pending),
      warnings: publication.warnings || [],
      last_published_at: publication.last_published_at || null,
      published_bytes: publishedBytes(location.mainRoot),
    },
    seals: sealStats(store, state && state.machine),
    latency: latencyStats(store),
    errors: errorStats(store),
    capture_hint: state && state.activated ? captureHint(location, tools) : null,
    llm: state && state.activated ? require('../worker/synthesis.js').llmStatus(location.commonDir) : null,
    runtime: { cli_node: process.version, git: gitVersion() },
  };
}

function render(status) {
  const lines = [`Repository: ${status.repo.root}`];
  if (!status.activated) {
    lines.push('State: not active. Run: product-decisions init');
    return lines;
  }
  const p = status.project;
  lines.push(`State: ${status.paused ? 'paused' : 'active'}, as ${status.actor}`);
  lines.push(p.declared
    ? `Project: declared; folder ${p.folder}/, language ${p.language}, tracking ${p.tracked_documents.join(', ') || 'no documents'}`
    : 'Project: not declared yet. Run: product-decisions init');
  const tools = Object.entries(status.tools);
  if (tools.length === 0) lines.push('Captured: nothing yet. Start a new session.');
  for (const [tool, stats] of tools) {
    lines.push(`${tool}: ${stats.sessions} sessions, ${stats.events} captured events (+${stats.derived} added), last at ${stats.last_event_at}`);
  }
  const pub = status.publication;
  if (!pub.remote) {
    lines.push('Publication: no remote, so nothing is shared.');
  } else {
    const pending = [pub.docs_pending && 'documents', pub.raw_pending && 'raw record'].filter(Boolean);
    lines.push(`Publication: ${pub.remote}, visibility ${pub.visibility || 'not checked yet'}, last published ${pub.last_published_at || 'never'}${pending.length ? `; pending: ${pending.join(' and ')}` : ''}`);
  }
  for (const warning of pub.warnings) {
    if (warning === 'raw_ref_public') lines.push('Warning: this repository is public and holds a published raw record.');
  }
  if (status.llm) {
    const l = status.llm;
    const mode = !l.project_enabled ? 'off for this project' : !l.person_enabled ? 'off for you' : 'on';
    const error = l.last_error ? `, last error: ${l.last_error.reason} at ${l.last_error.at}` : '';
    lines.push(`LLM synthesis: ${mode}, model ${l.model}, ${l.runs_today} of ${l.max_runs_per_day} runs today, ${l.pending_sessions} sessions pending${error}`);
  }
  lines.push(`Seals: ${status.seals.sessions} sessions, ${status.seals.unsealed_events} events not sealed yet, ${status.seals.problems} problems`);
  lines.push(`Stored: ${(status.store.bytes / 1024).toFixed(1)} KiB on this machine`);
  if (status.latency.count > 0) {
    lines.push(`Hook time: p50 ${status.latency.p50} ms, p95 ${status.latency.p95} ms (${status.latency.count} runs)`);
  }
  lines.push(`Errors: ${status.errors.count}${status.errors.last_at ? `, last at ${status.errors.last_at}` : ''}`);
  if (status.capture_hint) lines.push(`Note: ${status.capture_hint}`);
  lines.push(`This command runs on Node ${status.runtime.cli_node}, Git ${status.runtime.git}`);
  return lines;
}

/** Shows what is active and what has been captured. Never shows captured content. */
function status({ cwd, flags }) {
  const report = collect(requireRepo(cwd));
  console.log(flags.json ? JSON.stringify(report, null, 2) : render(report).join('\n'));
  return 0;
}

module.exports = { status };
