import { ConfigError } from './errors.ts';
import { defineLimits, UNBOUNDED, type LimitFinding, type LimitSpec, type LimitValue } from './limits.ts';
import { isPlainObject } from './util.ts';

const HOUR_MS = 3_600_000;

/** Every limit of the core, declared once: validation, the readiness gate and the docs read this list. */
export const SYSTEM_LIMITS = defineLimits({
  timeoutMs: { path: 'limits.system.timeoutMs', default: 300_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { min: 1, max: HOUR_MS }, why: 'Deadline of a system run when the host passes none.' },
  maxSteps: { path: 'limits.system.maxSteps', default: 20, unit: 'count', min: 1, unbounded: 'fail', safe: { min: 1, max: 100 }, why: 'Member calls in one run.' },
  maxDepth: { path: 'limits.system.maxDepth', default: 3, unit: 'count', min: 0, unbounded: 'fail', safe: { min: 0, max: 10 }, why: 'Hops a system run may add when the host passes no bounds.' },
  maxParallel: { path: 'limits.system.maxParallel', default: 4, unit: 'count', min: 1, max: 64, safe: { min: 1, max: 16 }, why: 'Branches running at once.' },
  maxIterations: { path: 'limits.system.maxIterations', default: 5, unit: 'count', min: 1, max: 100, safe: { min: 1, max: 20 }, why: 'Default bound of a loop.' },
  maxHandoffs: { path: 'limits.system.maxHandoffs', default: 10, unit: 'count', min: 1, max: 100, safe: { min: 1, max: 20 }, why: 'Default bound of a handoff.' },
  maxRepeats: { path: 'limits.system.maxRepeats', default: 3, unit: 'count', min: 1, max: 100, safe: { min: 1, max: 10 }, why: 'Back-and-forth between the same two members.' },
  stepTimeoutMs: { path: 'limits.system.stepTimeoutMs', default: 300_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { min: 1, max: HOUR_MS }, why: 'One member call, capped by the time left.' },
  cardTtlMs: { path: 'limits.registry.cardTtlMs', default: 300_000, unit: 'ms', min: 0, max: 86_400_000, why: 'How long a fetched card is trusted.' },
  maxCardBytes: { path: 'limits.registry.maxCardBytes', default: 65_536, unit: 'bytes', min: 1024, max: 1_048_576, why: 'Largest card read.' },
  maxCandidates: { path: 'limits.router.maxCandidates', default: 20, unit: 'count', min: 1, max: 200, safe: { min: 1, max: 50 }, why: 'Candidates sent to a model or knowledge router.' },
  maxRecords: { path: 'limits.attribution.maxRecords', default: 500, unit: 'count', min: 1, max: 100_000, why: 'Hop records read by one attribution.' },
});

export type LimitKey = keyof typeof SYSTEM_LIMITS;
/** Resolved limits: a number, or `"unbounded"` where the limit allows it. */
export type SystemLimits = Record<LimitKey, LimitValue>;
export type Env = Record<string, string | undefined>;

/** The value to enforce as a number: `"unbounded"` becomes `Infinity`. */
export const limitNumber = (value: LimitValue): number => (value === UNBOUNDED ? Infinity : value);

const ENV_REF = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/;
const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;

/** What is wrong with one limit value, or undefined when it is accepted. */
export function limitProblem(spec: LimitSpec, value: unknown): string | undefined {
  const what = `${spec.integer === false ? 'a number' : 'an integer'}${spec.unbounded ? ' or "unbounded"' : ''}`;
  if (value === UNBOUNDED) return spec.unbounded ? undefined : `must be ${what} ("unbounded" is not allowed here)`;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `must be ${what}`;
  if (spec.integer !== false && !Number.isInteger(value)) return `must be ${what}`;
  if (value < spec.min) return `must be >= ${spec.min}`;
  if (spec.max !== undefined && value > spec.max) return `must be <= ${spec.max}`;
  return undefined;
}

/** A whole-string `${env:NAME}` or `${env:NAME:-default}` becomes the variable's value; anything else is returned as is. */
function fromEnv(spec: LimitSpec, raw: unknown, env: Env, problems: string[]): unknown {
  if (typeof raw !== 'string') return raw;
  const ref = ENV_REF.exec(raw);
  if (!ref) return raw;
  const text = env[ref[1]!] || ref[2];
  if (text === undefined) {
    problems.push(`${spec.path}: environment variable ${ref[1]} is not set`);
    return undefined;
  }
  if (text === UNBOUNDED) return UNBOUNDED;
  if (NUMERIC.test(text)) return Number(text);
  problems.push(`${spec.path}: environment variable ${ref[1]} is not a number`);
  return undefined;
}

/**
 * Reads the `limits` section: absent values take the default, `${env:...}` references are filled in, and every value
 * is range-checked. Problems are appended to `problems`, one per value, naming the path; the default stands in.
 */
export function collectLimits(config: unknown, env: Env, problems: string[]): SystemLimits {
  const section = config === undefined || config === null ? {} : config;
  if (!isPlainObject(section)) {
    problems.push('limits: must be an object');
    return resolveDefaults();
  }
  const specs = Object.values(SYSTEM_LIMITS) as LimitSpec[];
  const known = new Set(specs.map((s) => s.path.split('.')[1]!));
  for (const name of Object.keys(section)) if (!known.has(name)) problems.push(`limits.${name}: unknown limit group`);
  const out: Record<string, LimitValue> = {};
  for (const [key, spec] of Object.entries(SYSTEM_LIMITS) as [string, LimitSpec][]) {
    const [, group, name] = spec.path.split('.') as [string, string, string];
    const raw = isPlainObject(section[group]) ? (section[group] as Record<string, unknown>)[name] : undefined;
    const value = raw === undefined || raw === null ? spec.default : fromEnv(spec, raw, env, problems);
    const problem = value === undefined ? undefined : limitProblem(spec, value);
    if (problem) problems.push(`${spec.path}: ${problem}`);
    out[key] = value !== undefined && !problem ? (value as LimitValue) : spec.default;
  }
  for (const group of known) {
    const values = section[group];
    if (values === undefined) continue;
    if (!isPlainObject(values)) { problems.push(`limits.${group}: must be an object`); continue; }
    const names = new Set(specs.filter((s) => s.path.split('.')[1] === group).map((s) => s.path.split('.')[2]));
    for (const name of Object.keys(values)) if (!names.has(name)) problems.push(`limits.${group}.${name}: unknown limit`);
  }
  return out as SystemLimits;
}

const resolveDefaults = (): SystemLimits => collectLimits(undefined, {}, []);

/** The limit values of a `limits` section; throws a ConfigError naming every rejected path. */
export function resolveLimits(config: unknown, env: Env = process.env): SystemLimits {
  const problems: string[] = [];
  const values = collectLimits(config, env, problems);
  if (problems.length) throw new ConfigError(problems);
  return values;
}

/** Readiness findings for one limit value on a production tier: unbounded with the limit's severity, or outside the safe range. */
export function limitFinding(spec: LimitSpec, value: LimitValue, path: string): LimitFinding[] {
  if (value === UNBOUNDED) return [{ severity: spec.unbounded ?? 'fail', path, value, message: `${path} is unbounded` }];
  const { min, max } = spec.safe ?? {};
  const out: LimitFinding[] = [];
  if (min !== undefined && value < min) out.push({ severity: 'warn', path, value, message: `${path} = ${value} is below the safe range ${min}-${max ?? 'unbounded'} ${spec.unit}` });
  if (max !== undefined && value > max) out.push({ severity: 'warn', path, value, message: `${path} = ${value} is above the safe range ${min ?? 0}-${max} ${spec.unit}` });
  return out;
}

/**
 * Findings of the readiness gate of a production-tier profile: `"unbounded"` with the limit's severity, and values
 * outside the safe range as warnings.
 */
export function limitFindings(values: SystemLimits): LimitFinding[] {
  return (Object.entries(SYSTEM_LIMITS) as [LimitKey, LimitSpec][]).flatMap(([key, spec]) => limitFinding(spec, values[key], spec.path));
}
