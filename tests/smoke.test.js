'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('package declares no dependencies and a Node floor', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.engines.node, '>=18');
  assert.equal(pkg.private, true);
});
