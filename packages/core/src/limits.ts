/** Configurable limits, declared once per component so validation, the readiness gate and the docs read one list. */
export const UNBOUNDED = 'unbounded';
export type Unbounded = typeof UNBOUNDED;
export type LimitValue = number | Unbounded;
export type LimitUnit = 'ms' | 'bytes' | 'count' | 'tokens' | 'usd';
export type LimitSeverity = 'warn' | 'fail';

export interface LimitSpec {
  /** Where it is set: `limits.system.maxSteps`, or `options.timeoutMs` for an adapter. */
  path: string;
  default: LimitValue;
  unit: LimitUnit;
  min: number;
  max?: number;
  integer?: boolean;
  /** `"unbounded"` is accepted; the production readiness gate reports it with this severity. */
  unbounded?: LimitSeverity;
  /** Range recommended for production; outside it is a warning on the production tier. */
  safe?: { min?: number; max?: number };
  why: string;
}

export interface LimitFinding {
  severity: LimitSeverity;
  path: string;
  value: LimitValue;
  message: string;
}

export function defineLimits<const K extends string>(specs: Record<K, LimitSpec>): Readonly<Record<K, LimitSpec>> {
  for (const s of Object.values(specs) as LimitSpec[]) {
    if (s.default === UNBOUNDED && !s.unbounded) throw new TypeError(`limit ${s.path}: default is unbounded but unbounded is not allowed`);
  }
  return Object.freeze(specs);
}
