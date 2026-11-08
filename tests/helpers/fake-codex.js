'use strict';

// A stand-in for `codex exec` in tests: no Codex account exists for this project, and
// tests must never reach a real one. Records argv, stdin, and the recursion guard in
// $FAKE_CODEX_LOG, and answers per $FAKE_CODEX_MODE.

const fs = require('node:fs');
const path = require('node:path');

function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', () => {
    const argv = process.argv.slice(2);
    if (process.env.FAKE_CODEX_LOG) {
      fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ argv, stdin, cwd: process.cwd(), synth: process.env.PRODUCT_DECISIONS_SYNTH, thread: process.env.CODEX_THREAD_ID })}\n`);
    }
    const out = argv[argv.indexOf('-o') + 1];
    const mode = process.env.FAKE_CODEX_MODE || 'ok';
    if (mode === 'ok') fs.writeFileSync(out, process.env.FAKE_CODEX_OUTPUT || '{"decisions":[],"phase_notes":[]}');
    else if (mode === 'garbage') fs.writeFileSync(out, 'not json at all');
    else if (mode === 'exit') process.exitCode = 3;
    else if (mode === 'sleep') setTimeout(() => {}, 10000);
    // no_output: exit 0 and write nothing.
  });
}

/** The npm shim text for a package whose entry is `rel` (Windows backslashes). */
const shimFor = (rel) => ['@ECHO off', 'SETLOCAL', 'CALL :find_dp0', `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`, ''].join('\r\n');

/** Installs the fake as `codex` in `dir`. @returns {string} The path for PRODUCT_DECISIONS_CODEX_BIN. */
function installFakeCodex(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const rel = 'node_modules\\@openai\\codex\\bin\\codex.js';
    const entry = path.join(dir, ...rel.split('\\'));
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.copyFileSync(__filename, entry);
    const shim = path.join(dir, 'codex.cmd');
    fs.writeFileSync(shim, shimFor(rel));
    return shim;
  }
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${__filename}" "$@"\n`, { mode: 0o755 });
  return bin;
}

module.exports = { installFakeCodex, shimFor };

if (require.main === module) main();
