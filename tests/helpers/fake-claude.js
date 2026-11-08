'use strict';

// A stand-in for `claude -p` in tests: CI has no login, and tests must never spend quota.
// It records what it was given in $FAKE_CLAUDE_LOG (one JSON line per call) and answers
// according to $FAKE_CLAUDE_MODE.

const fs = require('node:fs');
const path = require('node:path');

function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', () => {
    const argv = process.argv.slice(2);
    const systemAt = argv.indexOf('--system-prompt-file');
    let system = null;
    try {
      system = systemAt >= 0 ? fs.readFileSync(argv[systemAt + 1], 'utf8') : null;
    } catch {
      system = null;
    }
    if (process.env.FAKE_CLAUDE_LOG) {
      fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({
        argv, stdinLength: stdin.length, stdin, system, cwd: process.cwd(),
        synth: process.env.PRODUCT_DECISIONS_SYNTH, simple: process.env.CLAUDE_CODE_SIMPLE,
      })}\n`);
    }
    const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
    const print = (value, code = 0) => {
      process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
      process.exitCode = code;
    };
    const output = () => JSON.parse(process.env.FAKE_CLAUDE_OUTPUT || '{"decisions":[],"phase_notes":[]}');
    if (mode === 'ok') print({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: '', total_cost_usd: 0.01, structured_output: output() });
    else if (mode === 'budget') print({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget ($1)'], total_cost_usd: 1.2 }, 1);
    else if (mode === 'auth') print({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }, 1);
    else if (mode === 'garbage') print('hello');
    else if (mode === 'no_output') print({ type: 'result', subtype: 'success', is_error: false, result: 'text only', total_cost_usd: 0.01 });
    else if (mode === 'exit') print('', 2);
    else if (mode === 'sleep') setTimeout(() => print({ type: 'result', subtype: 'success', is_error: false, structured_output: output() }), 10000);
  });
}

/**
 * Installs the fake as `claude` in `dir`: a shell wrapper on POSIX, or an npm-style
 * `claude.cmd` shim with its `cli.js` on Windows.
 *
 * @returns {string} The path to put in PRODUCT_DECISIONS_CLAUDE_BIN.
 */
function installFakeClaude(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const entry = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.copyFileSync(__filename, entry);
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, npmShim());
    return shim;
  }
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${__filename}" "$@"\n`, { mode: 0o755 });
  return bin;
}

/** The text npm writes for a package binary on Windows. */
function npmShim() {
  return [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', '',
  ].join('\r\n');
}

module.exports = { installFakeClaude, npmShim };

if (require.main === module) main();
