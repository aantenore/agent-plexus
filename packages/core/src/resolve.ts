import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkDescriptor, type AdapterContext, type AdapterDescriptor, type Fills, type FillTypes } from './adapter.ts';
import { adapterLimitProblems, coerceLimitOptions, interpolate } from './adapter-config.ts';
import type { AdapterRef } from './config.ts';
import { AdapterError, ConfigError } from './errors.ts';
import { resolveImport } from './import-resolve.ts';
import { formatProblem, validate } from './schema.ts';
import { errorMessage, isPlainObject } from './util.ts';

/** Finds the descriptor of an adapter by name for a port; tests pass their own. Throws when it cannot. */
export type DescriptorLoader = (fills: Fills, name: string, cwd: string) => Promise<AdapterDescriptor>;

export interface Created<F extends Fills> {
  descriptor: AdapterDescriptor<F>;
  instance: FillTypes[F];
  /** The options the adapter was created with: `${env:...}` filled in, limit values numeric. */
  options: Record<string, unknown>;
}

const isPath = (name: string) => name.startsWith('.') || name.startsWith('/');

const describeAll = (list: AdapterDescriptor[]) => list.map((d) => `${d.name} (${d.fills})`).join(', ') || 'none';

/**
 * Imports `@agent-plexus/adapter-<name>`, or, for a name starting with `.` or `/`, the module at that path relative to
 * `cwd` (`./mine.js#name` picks one descriptor when the module has several for the port), and picks from its
 * `adapters` export the descriptor with that name that fills the port.
 */
export const loadDescriptor: DescriptorLoader = async (fills, name, cwd) => {
  const [target = name, wanted] = isPath(name) ? name.split('#') : [name];
  const file = resolve(cwd, target);
  const specifier = isPath(name) ? pathToFileURL(file).href : `@agent-plexus/adapter-${name}`;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' && errorMessage(err).includes(isPath(name) ? file : specifier)) {
      throw new Error(isPath(name) ? `module ${target} not found` : `is not installed (npm install @agent-plexus/adapter-${name})`);
    }
    throw new Error(`failed to load: ${errorMessage(err)}`);
  }
  if (!Array.isArray(mod.adapters)) throw new Error('module has no "adapters" export (an array of descriptors)');
  const all = (mod.adapters as AdapterDescriptor[]).filter((d) => isPlainObject(d));
  const named = all.filter((d) => (isPath(name) ? !wanted || d.name === wanted : d.name === name));
  const found = named.filter((d) => d.fills === fills);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new Error(`module has several adapters for ${fills}: ${describeAll(found)}; append #<name>`);
  if (named.length) throw new Error(`fills ${named.map((d) => d.fills).join(', ')}, expected ${fills}`);
  throw new Error(`module has no adapter for ${fills}${isPath(name) ? '' : ` named "${name}"`} (found: ${describeAll(all)})`);
};

const isDescriptor = (v: unknown): v is AdapterDescriptor =>
  isPlainObject(v) && typeof v.fills === 'string' && typeof v.name === 'string' && typeof v.create === 'function';

/**
 * Every adapter descriptor a module exports: in `adapters`, `default` or any named export, alone or in an array. A
 * `default` that is a plain object and not a descriptor (a CommonJS `module.exports`) is searched the same way.
 */
export function descriptorsOf(mod: Record<string, unknown>): AdapterDescriptor[] {
  const out = new Set<AdapterDescriptor>();
  const scan = (values: unknown[]): void => {
    for (const value of values) {
      for (const v of Array.isArray(value) ? value : [value]) if (isDescriptor(v)) out.add(v);
    }
  };
  scan(Object.values(mod));
  if (isPlainObject(mod.default) && !isDescriptor(mod.default)) scan(Object.values(mod.default));
  return [...out];
}

/** Imports a module as an `import` in `cwd` would: a path relative to it, or a package installed there (`resolveImport`). */
async function importFrom(specifier: string, cwd: string): Promise<Record<string, unknown>> {
  return (await import(resolveImport(specifier, cwd))) as Record<string, unknown>;
}

/** The descriptors a plugin exports; a plugin that exports none is an error, not an empty list. */
async function pluginDescriptors(specifier: string, cwd: string): Promise<AdapterDescriptor[]> {
  const found = descriptorsOf(await importFrom(specifier, cwd));
  if (!found.length) throw new Error('it exports no adapter descriptors');
  return found;
}

/**
 * A loader that looks an adapter up by name in the descriptors the `plugins` modules export (packages or paths,
 * resolved as an import in the config's directory, never from elsewhere; the first plugin listed wins), and asks
 * `fallback` for any other name. Each plugin is imported once, when an adapter is first looked up; one that cannot be
 * resolved or exports no descriptors is an error.
 */
export function pluginLoader(plugins: readonly string[], fallback: DescriptorLoader = loadDescriptor): DescriptorLoader {
  const loaded = new Map<string, Promise<AdapterDescriptor[]>>();
  const load = (cwd: string): Promise<AdapterDescriptor[]> => {
    let found = loaded.get(cwd);
    if (!found) {
      found = Promise.all(plugins.map((p) => pluginDescriptors(p, cwd).catch((err: unknown) => {
        throw new Error(`plugin "${p}" failed to load: ${errorMessage(err)}`, { cause: err });
      }))).then((lists) => lists.flat());
      found.catch(() => loaded.delete(cwd));
      loaded.set(cwd, found);
    }
    return found;
  };
  return async (fills, name, cwd) => {
    if (!plugins.length) return fallback(fills, name, cwd);
    const own = (await load(cwd)).find((d) => d.fills === fills && d.name === name);
    return own ?? fallback(fills, name, cwd);
  };
}

/**
 * Loads the descriptor, checks its shape and port version (`checkDescriptor`), fills `${env:...}` in `ref.options`, validates them (schema and declared limits) and creates the
 * instance. Errors name `where`.
 */
export async function createAdapter<F extends Fills>(
  load: DescriptorLoader, fills: F, ref: AdapterRef, ctx: AdapterContext, where: string,
): Promise<Created<F>> {
  let descriptor: AdapterDescriptor<F>;
  try {
    descriptor = (await load(fills, ref.adapter, ctx.cwd)) as AdapterDescriptor<F>;
  } catch (err) {
    throw new AdapterError(where, ref.adapter, errorMessage(err), { cause: err });
  }
  const unsound = checkDescriptor(descriptor);
  if (!unsound.length && descriptor.fills !== fills) unsound.push(`fills ${descriptor.fills}, expected ${fills}`);
  if (unsound.length) throw new AdapterError(where, ref.adapter, `cannot be used: ${unsound.join('; ')}`);
  const missing: string[] = [];
  const filled = interpolate(ref.options ?? {}, ctx.env, missing, `${where}.options`);
  if (missing.length) throw new ConfigError(missing);
  const limitSpecs = Object.values(descriptor.limits ?? {});
  const options = coerceLimitOptions(limitSpecs, filled);
  const problems = [
    ...(descriptor.optionsSchema ? validate(options, descriptor.optionsSchema, `${where}.options`).map(formatProblem) : []),
    ...adapterLimitProblems(limitSpecs, options, where),
  ];
  if (problems.length) throw new ConfigError(problems);
  try {
    return { descriptor, instance: await descriptor.create(options, ctx), options };
  } catch (err) {
    throw new AdapterError(where, ref.adapter, `failed to create: ${errorMessage(err)}`, { cause: err });
  }
}
