'use strict';

const { readLocal } = require('../core/state.js');
const { UsageError, requireRepo } = require('./shared.js');
const project = require('./project.js');

/** Rebuilds the local folder from the docs branch. Publication comes in a later task. */
function sync({ cwd }) {
  const location = requireRepo(cwd);
  const state = readLocal(location.commonDir);
  if (!state || !state.activated) throw new UsageError('product-decisions is not active in this repository. Run: product-decisions init');
  const declared = project.findDeclaration(location.mainRoot);
  if (!declared) throw new UsageError('This project is not declared yet. Run: product-decisions init');
  const config = project.materialize(location, declared);
  console.log(`The folder ${config.folder}/ is up to date.`);
  return 0;
}

module.exports = { sync };
