import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, type Io } from '../io.ts';

/** The starter: `examples/offline` copied into the package at build time by `scripts/copy-starter.mjs`. */
export const TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));

/** The packages a starter project installs, all at the version of this CLI (they are released in lockstep). */
const PACKAGES = ['@agent-plexus/adapters', '@agent-plexus/cli', '@agent-plexus/core'];

/** Entries `npm install` leaves in a folder before `init` runs there; they do not make the folder non-empty. */
const PROJECT_ENTRIES = new Set(['package.json', 'package-lock.json', 'node_modules']);

export interface InitArgs {
  /** The folder to write into, relative to the working directory; created when missing. */
  dir: string;
  /** Write into a folder that holds other files, replacing files of the same name. */
  force?: boolean;
  /** The version of this CLI: the range of the packages in a new `package.json`. */
  version: string;
}

type Manifest = { type?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } & Record<string, unknown>;

async function files(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(root, path)));
    else out.push(relative(root, path));
  }
  return out.sort();
}

/** Entries of `dir` other than dot files and what `npm install` creates; `undefined` when the folder does not exist. */
async function otherEntries(dir: string): Promise<string[] | undefined> {
  const info = await stat(dir).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return undefined; throw err; });
  if (!info) return undefined;
  if (!info.isDirectory()) throw new CliError(`${dir} is not a folder`);
  return (await readdir(dir)).filter((name) => !name.startsWith('.') && !PROJECT_ENTRIES.has(name)).sort();
}

/** A package name from a folder name: lower case, the characters npm accepts, never empty. */
const packageName = (dir: string): string => basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'plexus-system';

/**
 * Creates `package.json` when missing (`"type": "module"` and the packages as dev dependencies), or sets
 * `"type": "module"` in an existing one: the members are ES modules. Returns what it did and the packages to install.
 */
async function manifest(dir: string, version: string): Promise<{ note: string; install: string }> {
  const file = join(dir, 'package.json');
  const text = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return undefined; throw err; });
  if (text === undefined) {
    const pkg = { name: packageName(dir), version: '0.0.0', private: true, type: 'module', devDependencies: Object.fromEntries(PACKAGES.map((p) => [p, `^${version}`])) };
    await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
    return { note: 'package.json (new, "type": "module")', install: 'npm install' };
  }
  let pkg: Manifest;
  try {
    pkg = JSON.parse(text) as Manifest;
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  let note = 'package.json (unchanged)';
  if (pkg.type !== 'module') {
    note = `package.json ("type": "module"${pkg.type === undefined ? '' : `, was "${pkg.type}"`})`;
    pkg.type = 'module';
    await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  const missing = PACKAGES.filter((p) => !pkg.dependencies?.[p] && !pkg.devDependencies?.[p]);
  return { note, install: missing.length ? `npm install --save-dev ${missing.join(' ')}` : '' };
}

/** Writes the starter system into `dir` and prints the files and the commands to run next. */
export async function init(io: Io, args: InitArgs): Promise<number> {
  const dir = resolve(io.cwd, args.dir);
  const starter = await files(TEMPLATES).catch(() => {
    throw new CliError(`the starter is missing from ${TEMPLATES}: build @agent-plexus/cli first (npm run build)`);
  });
  const others = await otherEntries(dir);
  if (others?.length && !args.force) {
    const shown = others.slice(0, 5).join(', ') + (others.length > 5 ? ', ...' : '');
    throw new CliError(`${dir} is not empty (${shown}); use --force to write the starter into it, replacing files of the same name`);
  }
  for (const file of starter) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await copyFile(join(TEMPLATES, file), join(dir, file));
  }
  const { note, install } = await manifest(dir, args.version);
  const rel = relative(io.cwd, dir);
  io.out(`agent-plexus starter written to ${dir}:\n${[...starter, note].map((f) => `  ${f}`).join('\n')}`);
  const next = [
    ...(rel ? [`cd ${/^[\w./-]+$/.test(rel) ? rel : `'${rel.replaceAll("'", "'\\''")}'`}`] : []),
    ...(install ? [install] : []),
    'npx agent-plexus check',
    'npx agent-plexus run "I need a refund for my last invoice"',
    'npx agent-plexus eval cases.json',
  ];
  io.out(`next:\n${next.map((c) => `  ${c}`).join('\n')}`);
  return 0;
}
