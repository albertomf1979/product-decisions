'use strict';

// Goal G3 from the PRD. Runs the real process, so the figures include Node's startup.
// CI machines are slower and shared, so PD_LATENCY_FACTOR relaxes the budget there.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo, activate } = require('./helpers/repo.js');
const { factor, runHook, assertSilent, fixture } = require('./helpers/hook-runner.js');

const RUNS = 30;
const WARM_UP = 5;

function round(root, name) {
  const payload = fixture(name, { cwd: root });
  const stdin = JSON.stringify(payload);
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const result = runHook({ stdin, cwd: root, event: payload.hook_event_name });
    assertSilent(result);
    if (i >= WARM_UP) times.push(result.ms);
  }
  times.sort((a, b) => a - b);
  return {
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))],
  };
}

// The best of three rounds: the rest of the suite runs in parallel and starts workers,
// so one slow round says more about the machine's load than about the hook. A real
// regression is slow in every round.
function measure(root, name) {
  let best = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = round(root, name);
    if (!best || result.p95 < best.p95) best = result;
  }
  return best;
}

test('active: p95 is within budget', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  activate(root);
  const { p50, p95 } = measure(root, 'PostToolUse-Edit.json');
  t.diagnostic(`active: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
  assert(p95 <= 100 * factor, `p95 ${p95.toFixed(1)} ms`);
});

test('not activated: p95 is within budget', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const { p50, p95 } = measure(root, 'PostToolUse-Edit.json');
  t.diagnostic(`inactive: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
  assert(p95 <= 50 * factor, `p95 ${p95.toFixed(1)} ms`);
});

test('Stop, which also starts the worker: p95 is within budget', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  activate(root);
  const { p50, p95 } = measure(root, 'Stop.json');
  t.diagnostic(`stop with worker: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
  assert(p95 <= 100 * factor, `p95 ${p95.toFixed(1)} ms`);
});
