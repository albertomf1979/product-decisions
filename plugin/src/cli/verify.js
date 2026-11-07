'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { storeDir } = require('../core/state.js');
const { verifyFile } = require('../worker/seal.js');
const { requireRepo } = require('./shared.js');

function sessionFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sessionFiles(full);
      return entry.name.endsWith('.jsonl') ? [full] : [];
    });
  } catch {
    return [];
  }
}

/** Checks the hashes and seals of every session on this machine. Exit 1 on any problem. */
function verify({ cwd, flags }) {
  const location = requireRepo(cwd);
  const raw = path.join(storeDir(location.commonDir), 'raw');
  const files = sessionFiles(raw).sort().map((file) => ({ file: path.relative(raw, file).split(path.sep).join('/'), ...verifyFile(file) }));
  const problems = files.reduce((sum, f) => sum + f.problems.length, 0);

  if (flags.json) {
    console.log(JSON.stringify({ files, problems }, null, 2));
  } else {
    for (const f of files) {
      if (f.problems.length === 0) continue;
      for (const p of f.problems) console.log(`PROBLEM ${f.file}:${p.line} ${p.kind}${p.detail ? `, ${p.detail}` : ''}`);
    }
    const sealed = files.reduce((sum, f) => sum + f.sealed, 0);
    const unsealed = files.reduce((sum, f) => sum + f.unsealed, 0);
    const imported = files.reduce((sum, f) => sum + f.imported, 0);
    console.log(`${files.length} sessions, ${sealed} sealed events, ${unsealed} not sealed yet${imported ? `, ${imported} imported` : ''}.`);
    console.log(problems === 0 ? 'No problems found.' : `${problems} problems found.`);
  }
  return problems === 0 ? 0 : 1;
}

module.exports = { verify };
