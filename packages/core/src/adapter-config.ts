import type { LimitFinding, LimitSpec, LimitValue } from './limits.ts';
import { limitFinding, limitProblem, type Env } from './system-limits.ts';
import { isPlainObject } from './util.ts';

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;

/** Replaces `${env:NAME}` and `${env:NAME:-default}` in every string, recursively; a missing variable is a problem at its path. */
export function interpolate<T>(value: T, env: Env, problems: string[], path: string): T {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (_m, name: string, fallback: string | undefined) => {
      const v = env[name];
      if (v) return v;
      if (fallback !== undefined) return fallback;
      problems.push(`${path}: environment variable ${name} is not set`);
      return '';
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, problems, `${path}[${i}]`)) as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, problems, `${path}.${k}`)])) as T;
  return value;
}

interface Found { path: string; value: unknown; set(v: unknown): void }

/** Values at a limit path under `root`: `[]` walks arrays, `*` the values of a map; missing ones are skipped. */
function locate(root: unknown, path: string): Found[] {
  let level: Found[] = [{ path: '', value: root, set: () => {} }];
  for (const part of path.replace(/\[\]/g, '.[]').split('.').filter(Boolean)) {
    const next: Found[] = [];
    for (const f of level) {
      const v = f.value;
      if (part === '[]') {
        if (Array.isArray(v)) v.forEach((item, i) => next.push({ path: `${f.path}[${i}]`, value: item, set: (x) => { v[i] = x; } }));
      } else if (part === '*') {
        if (isPlainObject(v)) for (const [k, item] of Object.entries(v)) next.push({ path: `${f.path}.${k}`, value: item, set: (x) => { v[k] = x; } });
      } else if (isPlainObject(v) && v[part] !== undefined) {
        next.push({ path: f.path ? `${f.path}.${part}` : part, value: v[part], set: (x) => { v[part] = x; } });
      }
    }
    level = next;
  }
  return level;
}

/** Copy of the options with numeric strings at the adapter's limit paths turned into numbers (values from `${env:...}`). */
export function coerceLimitOptions(specs: readonly LimitSpec[], options: Record<string, unknown>): Record<string, unknown> {
  const root = { options: structuredClone(options) };
  for (const s of specs) for (const f of locate(root, s.path)) if (typeof f.value === 'string' && NUMERIC.test(f.value)) f.set(Number(f.value));
  return root.options;
}

/** Range problems of the limit values in an adapter's options, as `<where>.<path>: <problem>`. */
export function adapterLimitProblems(specs: readonly LimitSpec[], options: Record<string, unknown>, where: string): string[] {
  const root = { options };
  return specs.flatMap((s) => locate(root, s.path).flatMap((f) => {
    const problem = limitProblem(s, f.value);
    return problem ? [`${where}.${f.path}: ${problem}`] : [];
  }));
}

/** Production findings for an adapter's limits; absent values are judged by their default. Paths start with `where`. */
export function adapterLimitFindings(specs: readonly LimitSpec[], options: Record<string, unknown>, where: string): LimitFinding[] {
  const root = { options };
  return specs.flatMap((s) => {
    const found = locate(root, s.path);
    const values = found.length || /\[\]|\*/.test(s.path) ? found : [{ path: s.path, value: s.default }];
    return values.flatMap((f) => limitFinding(s, f.value as LimitValue, `${where}.${f.path}`));
  });
}
