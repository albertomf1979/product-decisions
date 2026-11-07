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

/**
 * What the last export wrote: the folder and its files. An older manifest is a bare
 * list of files, with no folder name.
 *
 * @returns {{ folder: string | null, files: string[] }}
 */
function readManifest(commonDir) {
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath(commonDir), 'utf8'));
    if (Array.isArray(value)) return { folder: null, files: value };
    return { folder: typeof value.folder === 'string' ? value.folder : null, files: Array.isArray(value.files) ? value.files : [] };
  } catch {
    return { folder: null, files: [] };
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
  const previous = readManifest(location.commonDir);
  // After a folder change the old folder is left as it is: its files are not this folder's.
  const stale = previous.folder === null || previous.folder === config.folder ? previous.files : [];
  for (const old of stale) {
    if (written.has(old)) continue;
    try {
      fs.rmSync(target(old), { force: true });
    } catch {
      // A path from an old manifest that is no longer safe is left alone.
    }
  }
  fs.mkdirSync(path.dirname(manifestPath(location.commonDir)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(manifestPath(location.commonDir), JSON.stringify({ folder: config.folder, files: [...written].sort() }));
}

module.exports = { addExclude, exportFolder, readManifest };
