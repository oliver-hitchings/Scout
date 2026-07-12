import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

// Node resolves module URLs through filesystem aliases. On macOS, for example,
// /var is an alias of /private/var, so comparing only path.resolve() can make a
// directly executed module look as though it was imported.
export function isMainModule(metaUrl, argvEntry = process.argv[1]) {
  return Boolean(argvEntry) && canonicalPath(argvEntry) === canonicalPath(fileURLToPath(metaUrl));
}
