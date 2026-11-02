import { DEPRECATED_EXT_KEYS, EXT_KEYS, type AdapterDescriptor, type Fills } from '@agent-plexus/core';

/** Time limits of the probes. */
export interface CheckLimits {
  /** Time limit of one probe (default 10000 ms). */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Collects the outcome of the checks of one suite. Every failure starts with the id of the rule it breaks (`E3: ...`),
 * so a test can single out one rule; every check is framework-free.
 */
export class Checks {
  readonly failures: string[] = [];
  readonly skipped: string[] = [];
  /** Notes that break no rule but should change (a deprecated form), with the rule id. */
  readonly warnings: string[] = [];
  /** Ids of the rules the suite evaluated, in order. */
  readonly rules: string[] = [];
  readonly timeoutMs: number;
  /** The descriptor under test, when the suite runs through `checkAdapter`. */
  readonly descriptor?: AdapterDescriptor<Fills, any>;
  /** The options the instance under test was created with, when the suite runs through `checkAdapter`. */
  readonly options?: unknown;

  constructor(limits: CheckLimits = {}, descriptor?: AdapterDescriptor<Fills, any>, options?: unknown) {
    this.timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (descriptor) this.descriptor = descriptor;
    if (options !== undefined) this.options = options;
  }

  /** Marks a rule as evaluated. */
  rule(id: string): void {
    if (!this.rules.includes(id)) this.rules.push(id);
  }

  expect(rule: string, ok: unknown, message: string): boolean {
    this.rule(rule);
    if (!ok) this.fail(rule, message);
    return !!ok;
  }

  fail(rule: string, message: string): void {
    this.rule(rule);
    const line = `${rule}: ${message}`;
    if (!this.failures.includes(line)) this.failures.push(line);
  }

  /** Every problem in `problems` is a failure of `rule`. */
  all(rule: string, problems: readonly string[], context: string): boolean {
    this.rule(rule);
    for (const p of problems) this.fail(rule, `${context}: ${p}`);
    return problems.length === 0;
  }

  skip(rule: string, message: string): void {
    this.skipped.push(`${rule}: ${message}`);
  }

  /** A note that does not fail the rule. */
  warn(rule: string, message: string): void {
    const line = `${rule}: ${message}`;
    if (!this.warnings.includes(line)) this.warnings.push(line);
  }

  /** Runs `fn`; a throw or a timeout becomes a failure of `rule` and resolves to undefined. */
  async attempt<T>(rule: string, label: string, fn: () => Promise<T> | T, timeoutMs = this.timeoutMs): Promise<T | undefined> {
    const out = await settle(fn, timeoutMs);
    if ('error' in out) {
      this.fail(rule, `${label}: ${out.timedOut ? `timed out after ${timeoutMs} ms` : `threw ${describeError(out.error)}`}`);
      return undefined;
    }
    this.rule(rule);
    return out.value;
  }

  /** Runs `fn` and expects it to reject within the time limit; resolves to the error, or undefined. */
  async rejects(rule: string, label: string, fn: () => Promise<unknown> | unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const out = await settle(fn, timeoutMs);
    if (!('error' in out)) {
      this.fail(rule, `${label}: expected a rejection`);
      return undefined;
    }
    if (out.timedOut) {
      this.fail(rule, `${label}: neither resolved nor rejected within ${timeoutMs} ms`);
      return undefined;
    }
    this.rule(rule);
    return out.error;
  }
}

export type Settled<T> = { value: T } | { error: unknown; timedOut?: boolean };

/** Runs `fn` with a time limit; a ref'd timer keeps the process alive while it waits. */
export async function settle<T>(fn: () => Promise<T> | T, timeoutMs: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = Symbol('timeout');
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise<typeof timedOut>((done) => { timer = setTimeout(() => done(timedOut), timeoutMs); }),
    ]);
    if (value === timedOut) return { error: new Error('timeout'), timedOut: true };
    return { value: value as T };
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

export const describeError = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const PROTOCOL_KEYS: readonly string[] = Object.values(EXT_KEYS);

/**
 * `ext` problems: every key namespaced as `<adapter>.<name>`, none in the core's `plexus` namespace but the protocol
 * keys (`plexus.delegate`, `plexus.handoff`). The deprecated bare `delegate` and `handoff` are no problem here: see
 * `extWarnings`.
 */
export function extProblems(ext: unknown): string[] {
  if (ext === undefined) return [];
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return ['ext must be an object'];
  const out: string[] = [];
  for (const key of Object.keys(ext)) {
    if (Object.hasOwn(DEPRECATED_EXT_KEYS, key)) continue;
    if (!/^[^.\s]+\.[^\s]+$/.test(key)) out.push(`ext key "${key}" is not namespaced as <adapter>.<name>`);
    else if (key.startsWith('plexus.') && !PROTOCOL_KEYS.includes(key)) out.push(`ext key "${key}" is in the core's plexus namespace`);
  }
  return out;
}

/** `ext` notes that fail no rule: a deprecated bare protocol key, with the key that replaces it. */
export function extWarnings(ext: unknown): string[] {
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return [];
  return Object.keys(ext).filter((key) => Object.hasOwn(DEPRECATED_EXT_KEYS, key))
    .map((key) => `ext key "${key}" is deprecated: use "${DEPRECATED_EXT_KEYS[key]}"`);
}

/** A unique id for one probe, so checks never share a run, a key or a name. */
let seq = 0;
export const uniqueId = (label: string): string => `conformance-${label}-${process.pid}-${Date.now().toString(36)}-${++seq}`;
