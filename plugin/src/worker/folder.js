'use strict';

// The local documentation folder: a plain export of the docs branch (spike S2).

const fs = require('node:fs');
const path = require('node:path');
const { storeDir } = require('../core/state.js');

/** Adds the folder to .git/info/exclude once, so Git and content searches ignore it. */
function addExclude(commonDir, folder) {
  const file = path.join(commonDir, 'info', 'exclude');
  const line = `/${folder}/`;
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  if (current.split(/\r?\n/).includes(line)) return;
  fs.appendFileSync(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${line}\n`);
}

const manifestPath = (commonDir) => path.join(storeDir(commonDir), 'state', 'export-manifest.json');

function readManifest(commonDir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(commonDir), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Writes the folder in the main checkout. Removes only files a previous export wrote
 * and the new one no longer has: anything a person put there stays.
 *
 * @param {{ location: object, config: object, files: Map<string, Buffer | string> }} options
 */
function exportFolder({ location, config, files }) {
  const root = path.join(location.mainRoot, config.folder);
  const target = (file) => {
    const full = path.resolve(root, file);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`refusing to write outside the folder: ${file}`);
    return full;
  };
  const entries = [...files.entries()].map(([file, content]) => [target(file), file, Buffer.isBuffer(content) ? content : Buffer.from(content)]);

  for (const [full, , content] of entries) {
    let same = false;
    try {
      same = fs.readFileSync(full).equals(content);
    } catch {
      // Not written yet.
    }
    if (same) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const written = new Set(entries.map(([, file]) => file));
  for (const old of readManifest(location.commonDir)) {
    if (written.has(old)) continue;
    try {
      fs.rmSync(target(old), { force: true });
    } catch {
      // A path from an old manifest that is no longer safe is left alone.
    }
  }
  fs.mkdirSync(path.dirname(manifestPath(location.commonDir)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(manifestPath(location.commonDir), JSON.stringify([...written].sort()));
}

module.exports = { addExclude, exportFolder };
