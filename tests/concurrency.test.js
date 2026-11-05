'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo, activate } = require('./helpers/repo.js');
const { runHookAsync, assertSilent, fixture, capturedEvents } = require('./helpers/hook-runner.js');

test('parallel hooks with large payloads produce only valid lines', async (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  activate(root);
  const COUNT = 40;
  const results = await Promise.all(Array.from({ length: COUNT }, (_, i) => runHookAsync({
    cwd: root,
    event: 'PostToolUse',
    stdin: JSON.stringify(fixture('PostToolUse-Read.json', {
      cwd: root, session_id: 'shared', tool_use_id: `call-${i}`, tool_response: `${i}:`.padEnd(256 * 1024, 'y '),
    })),
  })));
  results.forEach((result, i) => assertSilent(result, `process ${i}`));
  // capturedEvents parses every line, so a torn write fails here.
  const events = capturedEvents(root);
  assert.equal(events.length, COUNT);
  assert.equal(new Set(events.map((event) => event.payload.tool_use_id)).size, COUNT);
});
