'use strict';

// The work each job does.
module.exports = {
  /** @returns {Promise<void>} */
  turn: (job, ctx) => require('./turn.js').runTurn(job, ctx),
  /** @returns {Promise<void>} */
  publish: (ctx) => require('./publish.js').publish({ commonDir: ctx.commonDir }),
  /** @returns {Promise<object[]>} Jobs for sessions that ended without a close event. */
  recover: (ctx) => require('./turn.js').recoverSessions(ctx),
};
