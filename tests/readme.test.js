'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderSample } = require('./helpers/sample-output.js');

const ROOT = path.join(__dirname, '..');
// A Windows checkout may turn every line ending into CRLF.
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  assert.ok(from >= 0 && to > from, `the README has ${start} and ${end}`);
  return text.slice(from + start.length, to);
};

test('the sample output in the README is what the renderers produce', () => {
  assert.equal(between(readme, '<!-- sample:start -->', '<!-- sample:end -->').trim(), renderSample().trim());
});

test('the README never claims more than the code does', () => {
  for (const claim of [/Nothing in your working tree changes/, /needs no model and costs nothing/, /cites the events that prove it/, /Codex sessions are synthesized only on/]) {
    assert.doesNotMatch(readme, claim);
  }
});

test('the README covers what the PRD asks of it', () => {
  for (const phrase of [
    /npx github:albertomf1979\/product-decisions#v1\.0\.0 init/, /pending review/, /30 days/, /teleport/,
    /does not prove authorship/, /rotate/i, /personal data/, /product-decisions\/docs/, /claude\.ai/, /model turn/,
    /re-approve/, /Windows/, /sync --llm/, /daily cap/, /MIT/, /becomes public/, /no legal advice/,
    // The review of M6: what the runbook and init really do.
    /init --push/, /--llm/, /stops publishing/, /\.git\/info\/exclude/, /keeps your earlier choices/,
  ]) assert.match(readme, phrase);
});

test('the README names the version in package.json wherever it pins one', () => {
  const pins = [...readme.matchAll(/#v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(pins.length > 0);
  assert.deepEqual([...new Set(pins)], [version]);
});

test('the README documents every command the CLI has, and the wrappers that exist', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'plugin', 'src', 'cli', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const commands = [...between(cli, 'const COMMANDS = {', '};').matchAll(/^\s+(\w+): \(\)/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 7);
  for (const command of commands) assert.match(readme, new RegExp(`^\\| \`${command}[ \`]`, 'm'), `command ${command}`);
  for (const name of ['status', 'verify']) {
    assert.ok(readme.includes(`/product-decisions:${name}`) && readme.includes(`$product-decisions:${name}`), `wrapper ${name}`);
  }
});
