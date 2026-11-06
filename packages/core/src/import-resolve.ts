import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPlainObject } from './util.ts';

/**
 * Resolves a module specifier as an `import` written in `dir` would: a path relative to `dir`, or a package installed
 * in a `node_modules` above it (or `dir`'s own package, by its name), through its `exports` with the conditions of an
 * import (`node`, `import`, `module-sync`, those given with `--conditions`, `default`) or its `main`. Never falls back to
 * another directory. Throws when the module cannot be resolved.
 */
export function resolveImport(specifier: string, dir: string): string {
  const found = resolveInstalled(specifier, dir);
  if (found === undefined) throw new Error(`package "${splitSpecifier(specifier)!.name}" is not installed where the config is (${dir})`);
  return found;
}

/**
 * `resolveImport` for a package that may not be installed where `dir` is: undefined then, so the caller can look
 * elsewhere. Any other problem throws: not a package name, a subpath the package does not export (the error carries
 * Node's own code for it, `ERR_PACKAGE_PATH_NOT_EXPORTED`), a target file that does not exist.
 */
export function resolveInstalled(specifier: string, dir: string): string | undefined {
  if (specifier.startsWith('.') || isAbsolute(specifier)) return pathToFileURL(resolve(dir, specifier)).href;
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier)) return specifier;
  const parsed = splitSpecifier(specifier);
  if (!parsed) throw new Error(`"${specifier}" is not a package name`);
  const found = findPackage(parsed.name, dir);
  if (!found) return undefined;
  const file = packageFile(found.dir, found.manifest, parsed.subpath, importConditions());
  if (file === undefined) {
    throw Object.assign(new Error(`package "${parsed.name}" exports no "${parsed.subpath}" for import`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
  if (!isFile(file)) throw new Error(`package "${parsed.name}" points "${parsed.subpath}" to a missing file (${file})`);
  return pathToFileURL(file).href;
}

/** Conditions an `import` matches in this process: Node's own and those passed with `--conditions` or `-C`. */
export function importConditions(): Set<string> {
  const args = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean)];
  const user: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const inline = /^(?:--conditions|-C)=(.+)$/.exec(arg);
    if (inline) user.push(inline[1]!);
    else if ((arg === '--conditions' || arg === '-C') && args[i + 1] !== undefined) user.push(args[++i]!);
  }
  return new Set(['node', 'import', 'module-sync', ...user, 'default']);
}

/** A bare specifier as package name and subpath (`.` or `./<rest>`). */
function splitSpecifier(specifier: string): { name: string; subpath: string } | undefined {
  const parts = specifier.split('/');
  const n = specifier.startsWith('@') ? 2 : 1;
  if (parts.length < n || parts.slice(0, n).some((p) => !p || p === '.' || p === '..')) return undefined;
  const rest = parts.slice(n).join('/');
  return { name: parts.slice(0, n).join('/'), subpath: rest ? `./${rest}` : '.' };
}

interface Found {
  dir: string;
  manifest: Record<string, unknown>;
}

function readManifest(file: string): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isPlainObject(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The package `name` as seen from `dir`: its own package when named so (with `exports`), else in `node_modules` above. */
function findPackage(name: string, dir: string): Found | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const own = readManifest(join(at, 'package.json'));
    if (own && own.name === name && own.exports !== undefined) return { dir: at, manifest: own };
    const installed = join(at, 'node_modules', name);
    const manifest = readManifest(join(installed, 'package.json'));
    if (manifest) return { dir: installed, manifest };
    if (dirname(at) === at) return undefined;
  }
}

/** The file a subpath of a package resolves to, or undefined when the package does not export it for import. */
function packageFile(dir: string, manifest: Record<string, unknown>, subpath: string, conditions: Set<string>): string | undefined {
  if (manifest.exports !== undefined) {
    const target = exportsTarget(manifest.exports, subpath, conditions);
    return target === undefined ? undefined : resolve(dir, target);
  }
  if (subpath !== '.') return resolve(dir, subpath);
  const main = typeof manifest.main === 'string' && manifest.main ? manifest.main : undefined;
  const candidates = main ? [main, `${main}.js`, join(main, 'index.js')] : [];
  return [...candidates, 'index.js'].map((c) => resolve(dir, c)).find(isFile) ?? resolve(dir, main ?? 'index.js');
}

const isSubpathMap = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((k) => k.startsWith('.'));

/** The `exports` target of a subpath (exact, then the longest `*` pattern), as a path relative to the package. */
function exportsTarget(exports: unknown, subpath: string, conditions: Set<string>): string | undefined {
  const map = isSubpathMap(exports) ? exports : { '.': exports };
  if (Object.hasOwn(map, subpath) && !subpath.includes('*')) return conditionalTarget(map[subpath], '', conditions);
  let best: { key: string; match: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star < 0 || key.indexOf('*', star + 1) >= 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length < key.length - 1 || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (!best || prefix.length > best.key.indexOf('*')) best = { key, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  return best ? conditionalTarget(map[best.key], best.match, conditions) : undefined;
}

/** A target as the conditions select it: a `./` path (with `*` filled), the first of an array that resolves, or none. */
function conditionalTarget(target: unknown, match: string, conditions: Set<string>): string | undefined {
  if (typeof target === 'string') return target.startsWith('./') ? target.replaceAll('*', match) : undefined;
  if (Array.isArray(target)) {
    for (const t of target) {
      const found = conditionalTarget(t, match, conditions);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isPlainObject(target)) return undefined;
  for (const [condition, value] of Object.entries(target)) {
    if (!conditions.has(condition)) continue;
    const found = conditionalTarget(value, match, conditions);
    if (found !== undefined) return found;
  }
  return undefined;
}
