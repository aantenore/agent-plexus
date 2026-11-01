import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdapterContext, AdapterDescriptor, Fills, FillTypes } from './adapter.ts';
import { adapterLimitProblems, coerceLimitOptions, interpolate } from './adapter-config.ts';
import type { AdapterRef } from './config.ts';
import { AdapterError, ConfigError } from './errors.ts';
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

/**
 * Loads the descriptor, fills `${env:...}` in `ref.options`, validates them (schema and declared limits) and creates the
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
