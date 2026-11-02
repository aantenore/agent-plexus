import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { TIERS, type JsonSchema, type Tier } from './adapter.ts';
import { ConfigError } from './errors.ts';
import { formatProblem, validate, type Problem } from './schema.ts';
import { RUN_STATUSES, type Condition, type TopologyKind, type TopologySpec } from './shapes.ts';
import { collectLimits, type Deprecation, type Env, type SystemLimits } from './system-limits.ts';
import { childNodes } from './topology-walk.ts';
import { errorMessage, isPlainObject } from './util.ts';

export interface AdapterRef {
  adapter: string;
  options?: Record<string, unknown>;
}

export interface PortsConfig {
  registry?: AdapterRef;
  /** One router, or named routers; the `router` key is the default. */
  router?: AdapterRef | Record<string, AdapterRef>;
  topology: AdapterRef;
  execution: AdapterRef;
  attribution: AdapterRef;
}

/** Limits as written: numbers, `"unbounded"` or `${env:NAME}` references, by group. */
export type LimitsConfig = Partial<Record<'system' | 'router' | 'attribution', Record<string, number | string>>>;

/** Contents of a system config file. */
export interface SystemConfig {
  $schema?: string;
  system: { name: string };
  /** Modules (packages or paths) whose exported descriptors are found by name before `@agent-plexus/adapters/<name>`. */
  plugins?: string[];
  /** Absent or null: the prototype host. */
  host?: AdapterRef | null;
  members: Record<string, AdapterRef>;
  ports: PortsConfig;
  topology: TopologySpec;
  limits?: LimitsConfig;
  registry?: { requireSigned?: boolean; requireListed?: boolean };
  tier?: Tier;
  profiles?: Record<string, ProfileConfig>;
}

type Overlay<T> = { [K in keyof T]?: Overlay<T[K]> | null };

/** A profile: any part of the config, merged onto the base; `null` removes a key, arrays replace. */
export type ProfileConfig = Overlay<Omit<SystemConfig, 'profiles' | '$schema'>>;

/** A config with one profile applied and limits resolved. */
export interface ResolvedConfig {
  name: string;
  profile?: string;
  tier: Tier;
  host?: AdapterRef;
  /** Adapter modules looked up by name first (`pluginLoader`); empty when none. */
  plugins: string[];
  members: Record<string, AdapterRef>;
  ports: {
    registry?: AdapterRef;
    /** Routers by name; `router` is the default. */
    routers: Record<string, AdapterRef>;
    topology: AdapterRef;
    execution: AdapterRef;
    attribution: AdapterRef;
  };
  topology: TopologySpec;
  limits: SystemLimits;
  /** `requireListed`: every member call needs the registry to return the member. */
  registry: { requireSigned: boolean; requireListed: boolean };
  /** Directory of the config file; relative paths resolve against it. */
  cwd: string;
  /** Parts of the config that are accepted but ignored; the readiness gate warns about each. */
  deprecated?: Deprecation[];
}

export interface LoadOptions {
  profile?: string;
  env?: Env;
}

export interface ResolveOptions extends LoadOptions {
  cwd: string;
  /** Named in the error when the config is invalid. */
  file?: string;
}

const NAME = { type: 'string', minLength: 1 } as const;
const ADAPTER_REF: JsonSchema = {
  type: 'object',
  required: ['adapter'],
  properties: { adapter: NAME, options: { type: 'object' } },
  additionalProperties: false,
};

const CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['system', 'members', 'ports', 'topology'],
  properties: {
    $schema: { type: 'string' },
    system: { type: 'object', required: ['name'], properties: { name: NAME }, additionalProperties: false },
    plugins: { type: 'array', items: NAME },
    host: ADAPTER_REF,
    members: { type: 'object', additionalProperties: ADAPTER_REF },
    ports: {
      type: 'object',
      required: ['topology', 'execution', 'attribution'],
      properties: { registry: ADAPTER_REF, router: { type: 'object' }, topology: ADAPTER_REF, execution: ADAPTER_REF, attribution: ADAPTER_REF },
      additionalProperties: false,
    },
    topology: { type: 'object' },
    limits: { type: 'object' },
    registry: { type: 'object', properties: { requireSigned: { type: 'boolean' }, requireListed: { type: 'boolean' } }, additionalProperties: false },
    tier: { enum: [...TIERS] },
  },
  additionalProperties: false,
};

const IDS: JsonSchema = { type: 'array', items: NAME };
const COUNT: JsonSchema = { type: 'integer', minimum: 1 };

const KIND_FIELDS: Record<TopologyKind, { required: string[]; properties: Record<string, JsonSchema> }> = {
  sequence: { required: ['steps'], properties: { steps: { type: 'array' } } },
  parallel: { required: ['branches'], properties: { branches: { type: 'array' }, join: { enum: ['all', 'first'] }, merge: {} } },
  route: {
    required: ['candidates'],
    properties: {
      candidates: { oneOf: [IDS, { type: 'object', properties: { skills: IDS, tags: IDS, attrs: { type: 'object' } }, additionalProperties: false }] },
      router: NAME,
      fallback: {},
    },
  },
  loop: { required: ['body', 'until'], properties: { body: {}, until: {}, maxIterations: COUNT } },
  handoff: { required: ['start', 'members'], properties: { start: NAME, members: IDS, router: NAME, maxHandoffs: COUNT } },
  supervise: { required: ['supervisor', 'members'], properties: { supervisor: NAME, members: IDS } },
  graph: {
    required: ['nodes', 'start', 'edges', 'end'],
    properties: {
      nodes: { type: 'object' },
      start: NAME,
      edges: { type: 'array', items: { type: 'object', required: ['from', 'to'], properties: { from: NAME, to: NAME, when: {} }, additionalProperties: false } },
      end: IDS,
    },
  },
};

const KIND_SCHEMAS = Object.fromEntries(Object.entries(KIND_FIELDS).map(([kind, f]): [string, JsonSchema] => [kind, {
  type: 'object',
  required: ['kind', ...f.required],
  properties: { kind: { enum: [kind] }, name: { type: 'string' }, input: { enum: ['output', 'original'] }, ext: { type: 'object' }, ...f.properties },
  additionalProperties: false,
}])) as Record<TopologyKind, JsonSchema>;

const NONEMPTY: Partial<Record<TopologyKind, string[]>> = {
  sequence: ['steps'], parallel: ['branches'], handoff: ['members'], supervise: ['members'], graph: ['nodes', 'end'],
};

const CONDITION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    status: { oneOf: [{ enum: [...RUN_STATUSES] }, { type: 'array', items: { enum: [...RUN_STATUSES] } }] },
    code: { oneOf: [NAME, IDS] },
    ext: { type: 'object' },
    matches: { type: 'string' },
    fn: NAME,
  },
  additionalProperties: false,
};

function conditionProblems(cond: unknown, path: string, out: Problem[]): void {
  const own = validate(cond, CONDITION_SCHEMA, path);
  out.push(...own);
  if (own.length || !isPlainObject(cond)) return;
  if (typeof cond.matches === 'string') {
    try { new RegExp(cond.matches); } catch { out.push({ path: `${path}.matches`, message: 'not a valid regular expression' }); }
  }
  if (typeof cond.fn === 'string' && !/^[^#]+#[^#]+$/.test(cond.fn)) out.push({ path: `${path}.fn`, message: 'expected "<module>#<export>"' });
}

/** Shape of a topology node and everything below it; whether the members and routers exist is `topologyProblems`. */
function nodeProblems(node: unknown, path: string, out: Problem[]): void {
  if (typeof node === 'string') {
    if (!node) out.push({ path, message: 'member id must not be empty' });
    return;
  }
  if (!isPlainObject(node)) return void out.push({ path, message: 'expected a member id or a topology object' });
  const schema = typeof node.kind === 'string' ? KIND_SCHEMAS[node.kind as TopologyKind] : undefined;
  if (!schema) return void out.push({ path: `${path}.kind`, message: `must be one of ${Object.keys(KIND_SCHEMAS).join(', ')}` });
  const own = validate(node, schema, path);
  out.push(...own);
  if (own.length) return;
  const spec = node as unknown as TopologySpec;
  for (const field of NONEMPTY[spec.kind] ?? []) {
    const value = (node as Record<string, unknown>)[field];
    if (Array.isArray(value) ? value.length === 0 : Object.keys(value as object).length === 0) out.push({ path: `${path}.${field}`, message: 'must not be empty' });
  }
  if (spec.kind === 'loop') conditionProblems(spec.until, `${path}.until`, out);
  if (spec.kind === 'graph') spec.edges.forEach((e, i) => { if (e.when !== undefined) conditionProblems(e.when, `${path}.edges[${i}].when`, out); });
  for (const [child, childPath] of childNodes(spec, path)) nodeProblems(child, childPath, out);
}

function routerRefs(router: unknown, out: Problem[]): Record<string, AdapterRef> {
  if (router === undefined) return {};
  const path = '$.ports.router';
  if (isPlainObject(router) && typeof router.adapter === 'string') {
    out.push(...validate(router, ADAPTER_REF, path));
    return { router: router as unknown as AdapterRef };
  }
  out.push(...validate(router, { type: 'object', additionalProperties: ADAPTER_REF }, path));
  return router as Record<string, AdapterRef>;
}

/** An object that names a different adapter or kind replaces the base one: options belong to the adapter. */
function switched(base: Record<string, unknown>, overlay: Record<string, unknown>): boolean {
  return ['adapter', 'kind'].some((k) => typeof base[k] === 'string' && typeof overlay[k] === 'string' && base[k] !== overlay[k]);
}

/** Deep merge of a profile onto the base: objects merge, arrays and scalars replace, `null` removes the key. */
export function mergeConfig(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay) || switched(base, overlay)) return overlay;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) delete out[key];
    else out[key] = key in out ? mergeConfig(out[key], value) : value;
  }
  return out;
}

/**
 * Applies a profile to the raw config, checks its structure and resolves limits (`${env:NAME}` included). Every
 * problem is reported at once in one ConfigError. `tier` is `prototype` unless the config or profile says otherwise.
 */
export function resolveConfig(raw: unknown, opts: ResolveOptions): ResolvedConfig {
  const fail = (errors: string[]): never => {
    throw new ConfigError(opts.profile ? errors.map((e) => `${e} (profile ${opts.profile})`) : errors, opts.file);
  };
  if (!isPlainObject(raw)) return fail(['$: expected an object']);
  const { profiles, ...base } = raw;
  const out: Problem[] = [];
  const known = isPlainObject(profiles) ? profiles : {};
  if (profiles !== undefined && !isPlainObject(profiles)) out.push({ path: '$.profiles', message: 'expected an object' });
  for (const [name, p] of Object.entries(known)) if (!isPlainObject(p)) out.push({ path: `$.profiles.${name}`, message: 'expected an object' });
  if (opts.profile && !isPlainObject(known[opts.profile])) {
    return fail([...out.map(formatProblem), `$.profiles.${opts.profile}: not defined (known: ${Object.keys(known).join(', ') || 'none'})`]);
  }
  const merged = (opts.profile ? mergeConfig(base, known[opts.profile]) : base) as Record<string, unknown>;
  if (merged.host === null) delete merged.host;

  out.push(...validate(merged, CONFIG_SCHEMA));
  const ports = isPlainObject(merged.ports) ? merged.ports : {};
  const routers = routerRefs(ports.router, out);
  nodeProblems(merged.topology, '$.topology', out);
  const env = opts.env ?? process.env;
  const limitErrors: string[] = [];
  const deprecated: Deprecation[] = [];
  const limits = collectLimits(merged.limits, env, limitErrors, deprecated);
  if (out.length || limitErrors.length) return fail([...out.map(formatProblem), ...limitErrors]);

  const config = merged as unknown as SystemConfig;
  return {
    name: config.system.name,
    ...(opts.profile ? { profile: opts.profile } : {}),
    tier: config.tier ?? 'prototype',
    ...(config.host ? { host: config.host } : {}),
    plugins: config.plugins ?? [],
    members: config.members,
    ports: {
      ...(config.ports.registry ? { registry: config.ports.registry } : {}),
      routers,
      topology: config.ports.topology,
      execution: config.ports.execution,
      attribution: config.ports.attribution,
    },
    topology: config.topology,
    limits,
    registry: { requireSigned: config.registry?.requireSigned ?? false, requireListed: config.registry?.requireListed ?? false },
    cwd: opts.cwd,
    ...(deprecated.length ? { deprecated } : {}),
  };
}

/** Reads a config file (JSON), applies the profile and resolves it; relative paths resolve against the file's directory. */
export async function loadConfig(path: string, opts: LoadOptions = {}): Promise<ResolvedConfig> {
  const file = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new ConfigError([`cannot read as JSON: ${errorMessage(err)}`], file);
  }
  return resolveConfig(raw, { ...opts, cwd: dirname(file), file });
}
