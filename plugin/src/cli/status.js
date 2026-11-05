'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readLocal, storeDir } = require('../core/state.js');
const { requireRepo } = require('./shared.js');

const LATENCY_WINDOW = 1000;

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

/** Complete lines only: a line still being written has no newline yet. */
function completeLines(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.pop();
    return lines.filter(Boolean);
  } catch {
    return [];
  }
}

function timestampOf(line, field) {
  try {
    return JSON.parse(line)[field] ?? null;
  } catch {
    return null;
  }
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
    const stats = { sessions: 0, events: 0, last_event_at: null };
    for (const file of walk(path.join(rawDir, tool))) {
      const lines = completeLines(file);
      stats.sessions += 1;
      stats.events += lines.length;
      const last = lines.length ? timestampOf(lines[lines.length - 1], 'timestamp') : null;
      // Compared as instants, because timestamps can carry different offsets.
      if (last && (!stats.last_event_at || new Date(last) > new Date(stats.last_event_at))) stats.last_event_at = last;
    }
    tools[tool] = stats;
  }
  return tools;
}

function latencyStats(store) {
  const values = completeLines(path.join(store, 'logs', 'latency.jsonl'))
    .slice(-LATENCY_WINDOW)
    .map((line) => timestampOf(line, 'ms'))
    .filter((ms) => typeof ms === 'number')
    .sort((a, b) => a - b);
  const at = (q) => (values.length ? Number(values[Math.min(values.length - 1, Math.floor(values.length * q))].toFixed(1)) : null);
  return { count: values.length, p50: at(0.5), p95: at(0.95) };
}

function errorStats(store) {
  const lines = completeLines(path.join(store, 'logs', 'diagnostics.log'));
  return { count: lines.length, last_at: lines.length ? timestampOf(lines[lines.length - 1], 'ts') : null };
}

function gitVersion() {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^git version\s*/, '');
  } catch {
    return null;
  }
}

function collect(location) {
  const state = readLocal(location.commonDir);
  const store = storeDir(location.commonDir);
  const bytes = walk(store).reduce((sum, file) => {
    try {
      return sum + fs.statSync(file).size;
    } catch {
      return sum;
    }
  }, 0);
  return {
    repo: { root: location.mainRoot },
    activated: Boolean(state && state.activated),
    paused: Boolean(state && state.paused),
    actor: state ? state.actor_name : null,
    tools: toolStats(store),
    store: { bytes },
    latency: latencyStats(store),
    errors: errorStats(store),
    runtime: { node: process.version, git: gitVersion() },
  };
}

function render(status) {
  const lines = [`Repository: ${status.repo.root}`];
  if (!status.activated) {
    lines.push('State: not active. Run: product-decisions init');
    return lines;
  }
  lines.push(`State: ${status.paused ? 'paused' : 'active'}, as ${status.actor}`);
  const tools = Object.entries(status.tools);
  if (tools.length === 0) lines.push('Captured: nothing yet. Start a new session.');
  for (const [tool, stats] of tools) {
    lines.push(`${tool}: ${stats.sessions} sessions, ${stats.events} events, last at ${stats.last_event_at}`);
  }
  lines.push(`Stored: ${(status.store.bytes / 1024).toFixed(1)} KiB, only on this machine`);
  if (status.latency.count > 0) {
    lines.push(`Hook time: p50 ${status.latency.p50} ms, p95 ${status.latency.p95} ms (${status.latency.count} runs)`);
  }
  lines.push(`Errors: ${status.errors.count}${status.errors.last_at ? `, last at ${status.errors.last_at}` : ''}`);
  lines.push(`Runtime: Node ${status.runtime.node}, Git ${status.runtime.git}`);
  return lines;
}

/** Shows what is active and what has been captured. Never shows captured content. */
function status({ cwd, flags }) {
  const report = collect(requireRepo(cwd));
  console.log(flags.json ? JSON.stringify(report, null, 2) : render(report).join('\n'));
  return 0;
}

module.exports = { status };
