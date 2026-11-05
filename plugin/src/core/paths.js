'use strict';

/**
 * Makes a path relative to a folder when it lies inside it. String-based on purpose:
 * payload paths use the conventions of the machine that produced them.
 */
function relativeTo(target, folder) {
  if (typeof folder !== 'string' || folder === '' || !target.startsWith(folder)) return target;
  const rest = target.slice(folder.length);
  if (rest === '') return '.';
  return /^[\\/]/.test(rest) ? rest.slice(1) : target;
}

module.exports = { relativeTo };
