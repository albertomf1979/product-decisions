'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8'));

const REGISTERED = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart',
  'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'PostModelSwitch', 'PermissionDenied',
];
// Their presence, or their purpose, can change what the agent does (PRD CAP-2).
const FORBIDDEN = [
  'WorktreeCreate', 'WorktreeRemove', 'Elicitation', 'ElicitationResult', 'PermissionRequest', 'PreToolUse',
  'PreModelSwitch', 'PreModelRequest', 'UserPromptExpansion', 'TaskCreated', 'TaskCompleted', 'TeammateIdle',
  'MessageDisplay', 'Setup', 'ConfigChange',
];

test('registers exactly the PRD CAP-1 Claude Code events', () => {
  assert.deepEqual(Object.keys(read('plugin', 'hooks', 'hooks.json').hooks).sort(), [...REGISTERED].sort());
});

test('registers none of the forbidden events', () => {
  const { hooks } = read('plugin', 'hooks', 'hooks.json');
  for (const event of FORBIDDEN) assert(!(event in hooks), event);
});

test('every handler passes the tool and event to the script, with a timeout', () => {
  for (const [event, groups] of Object.entries(read('plugin', 'hooks', 'hooks.json').hooks)) {
    assert.equal(groups.length, 1, event);
    assert.equal(groups[0].matcher, undefined, `${event} must fire on every occurrence`);
    assert.equal(groups[0].hooks.length, 1, event);
    const [handler] = groups[0].hooks;
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, 'node');
    assert.deepEqual(handler.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/hook.js', 'claude-code', event]);
    assert.equal(handler.async, undefined, `${event} must be synchronous`);
    assert.equal(handler.onFailure, undefined, `${event} must never block on failure`);
    // A plugin's timeout cannot raise the SessionEnd budget, so it declares none.
    assert.equal(handler.timeout, event === 'SessionEnd' ? undefined : 5, event);
  }
});

test('the manifest names the plugin and has no email', () => {
  const manifest = read('plugin', '.claude-plugin', 'plugin.json');
  assert.equal(manifest.name, 'product-decisions');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.author.email, undefined);
  assert.equal(manifest.version, read('package.json').version);
});

test('the marketplace points at ./plugin', () => {
  const marketplace = read('.claude-plugin', 'marketplace.json');
  assert.equal(marketplace.name, 'product-decisions');
  assert.equal(marketplace.owner.email, undefined);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, 'product-decisions');
  assert.equal(marketplace.plugins[0].source, './plugin');
});

test('the plugin declares its own module type', () => {
  assert.equal(read('plugin', 'package.json').type, 'commonjs');
});

test('every registered event has a mapping in the adapter', () => {
  const { normalize } = require('../plugin/src/adapters/claude-code.js');
  for (const event of REGISTERED) assert.notEqual(normalize({ hook_event_name: event }), null, event);
});

// Codex (M4). Built from the documentation of 2026-11-08: pending review.
const CODEX_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'PreCompact', 'PostCompact', 'PostModelRequest'];

test('the Codex hook file registers exactly CAP-1 for Codex and nothing CAP-2 forbids', () => {
  const { hooks } = read('plugin', 'hooks', 'codex.json');
  assert.deepEqual(Object.keys(hooks).sort(), [...CODEX_EVENTS].sort());
  for (const forbidden of ['PreToolUse', 'PermissionRequest', 'PreModelRequest']) assert.ok(!(forbidden in hooks), forbidden);
});

test('every Codex hook runs our script as codex with its own event name, synchronously, with a short timeout', () => {
  for (const [event, groups] of Object.entries(read('plugin', 'hooks', 'codex.json').hooks)) {
    assert.equal(groups.length, 1, event);
    assert.equal(groups[0].matcher, undefined, event);
    const [hook] = groups[0].hooks;
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, `node "$PLUGIN_ROOT/scripts/hook.js" codex ${event}`);
    assert.ok(hook.timeout > 0 && hook.timeout <= 5, event);
    assert.equal(hook.async, undefined, event);
  }
});

test("neither tool can load the other tool's hooks", () => {
  const codexManifest = read('plugin', '.codex-plugin', 'plugin.json');
  assert.equal(codexManifest.hooks, './hooks/codex.json');
  assert.equal(codexManifest.name, read('plugin', '.claude-plugin', 'plugin.json').name);
  for (const groups of Object.values(read('plugin', 'hooks', 'hooks.json').hooks)) {
    for (const group of groups) for (const hook of group.hooks) assert.equal(hook.args[1], 'claude-code');
  }
  assert.equal(read('plugin', '.claude-plugin', 'plugin.json').hooks, undefined);
});

test('the Codex marketplace points at the plugin folder', () => {
  const market = read('.agents', 'plugins', 'marketplace.json');
  assert.equal(market.name, 'product-decisions');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, 'product-decisions');
  assert.deepEqual(market.plugins[0].source, { source: 'local', path: './plugin' });
});
