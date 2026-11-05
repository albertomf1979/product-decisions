'use strict';

const { readLocal, writeLocal } = require('../core/state.js');
const { formatTimestamp } = require('../core/event.js');
const { UsageError, requireRepo, appendLocalEvent } = require('./shared.js');

function requireActive(cwd) {
  const location = requireRepo(cwd);
  const state = readLocal(location.commonDir);
  if (!state || !state.activated) {
    throw new UsageError('product-decisions is not active in this repository. Run: product-decisions init');
  }
  return { location, state };
}

/** Stops capture for this person on this clone. */
function pause({ cwd }) {
  const { location, state } = requireActive(cwd);
  if (state.paused) {
    console.log('Capture is already paused.');
    return 0;
  }
  writeLocal(location.commonDir, { ...state, paused: true, paused_at: formatTimestamp() });
  console.log('Capture paused. Nothing will be recorded until you run: product-decisions resume');
  return 0;
}

/** Restarts capture and records the gap, with its time range and no content. */
function resume({ cwd }) {
  const { location, state } = requireActive(cwd);
  if (!state.paused) {
    console.log('Capture is not paused.');
    return 0;
  }
  const to = formatTimestamp();
  appendLocalEvent(location, state, cwd, {
    eventType: 'gap',
    summary: `Capture paused from ${state.paused_at} to ${to}`,
    payload: { from: state.paused_at, to },
  });
  writeLocal(location.commonDir, { ...state, paused: false, paused_at: null });
  console.log('Capture resumed.');
  return 0;
}

module.exports = { pause, resume };
