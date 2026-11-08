'use strict';

// The work each job does.
module.exports = {
  /** @returns {Promise<void>} */
  turn: (job, ctx) => require('./turn.js').runTurn(job, ctx),
  /**
   * Pushes only for a person who accepted the current consent text and left pushing on;
   * otherwise everything is committed on this machine only.
   *
   * @returns {Promise<object | null>}
   */
  publish: (ctx) => {
    const { readLocal } = require('../core/state.js');
    const { mayPush } = require('../core/consent.js');
    return require('./publish.js').publish({ commonDir: ctx.commonDir, push: mayPush(readLocal(ctx.commonDir)) });
  },
  /** @returns {Promise<object[]>} Jobs for sessions that ended without a close event. */
  recover: (ctx) => require('./turn.js').recoverSessions(ctx),
  /**
   * LLM synthesis of the ranges closed so far, within the caps. Its own checks decide
   * whether it runs at all (consent, opt-out, project switch).
   *
   * @returns {Promise<object>}
   */
  synthesize: (ctx) => {
    const { logError } = require('../core/diagnostics.js');
    return require('./synthesis.js').runSynthesis({ commonDir: ctx.commonDir, refresh: ctx.refresh, log: (err) => logError(ctx.commonDir, 'synthesis', err) });
  },
};
