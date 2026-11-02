// Shared helpers for the repository scripts. Zero dependencies.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const read = (path) => readFileSync(path, 'utf8');
export const readJson = (path) => JSON.parse(read(path));
export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Workspace folders from the root `workspaces` globs (only the `dir/*` form is used here). */
export function workspaces() {
  const out = [];
  for (const pattern of readJson(join(ROOT, 'package.json')).workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, '');
    const dirs = pattern.endsWith('/*') ? readdirSync(join(ROOT, base)).sort().map((d) => `${base}/${d}`) : [pattern];
    for (const dir of dirs) if (existsSync(join(ROOT, dir, 'package.json'))) out.push(dir);
  }
  return out;
}
