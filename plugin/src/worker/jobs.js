'use strict';

// The work each job does. Publishing is added by the publication task.
module.exports = {
  /** @returns {Promise<void>} */
  turn: (job, ctx) => require('./turn.js').runTurn(job, ctx),
  /** @returns {Promise<void>} */
  publish: async () => {},
  /** @returns {Promise<object[]>} Jobs for sessions that ended without a close event. */
  recover: (ctx) => require('./turn.js').recoverSessions(ctx),
};
