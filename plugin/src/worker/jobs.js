'use strict';

// The work each job does. Filled in by later milestones' tasks.
module.exports = {
  /** @returns {Promise<void>} */
  turn: async () => {},
  /** @returns {Promise<void>} */
  publish: async () => {},
  /** @returns {Promise<object[]>} Jobs for sessions that ended without a close event. */
  recover: async () => [],
};
