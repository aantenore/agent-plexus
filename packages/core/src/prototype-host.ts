import type { Attributes, Host, ScoreHook, SpanHandle, TelemetryHook } from './hooks.ts';
import { ATTR, SPAN } from './names.ts';
import type { EvalCase, HopRecord, Score, SystemResult } from './shapes.ts';

export interface PrototypeHostOptions {
  /** Print nothing. */
  quiet?: boolean;
  /** Where hop lines go (default: standard error). */
  write?: (line: string) => void;
  /** Reads a stored text by key, so member expectations can check outputs; without it only `status` is checked. */
  read?: (key: string) => Promise<string | undefined>;
}

const handle = (attrs: Attributes): SpanHandle => ({
  set: (more) => { Object.assign(attrs, more); },
  event: () => {},
});

/** Telemetry that records nothing. */
export const noopTelemetry: TelemetryHook = {
  span: (_name, attrs, fn) => fn(handle({ ...attrs })),
  event: () => {},
  metric: () => {},
};

function hopLine(attrs: Attributes, ms: number): string {
  return `plexus.hop member=${String(attrs[ATTR.member])} status=${String(attrs[ATTR.runStatus] ?? '-')} code=${String(attrs[ATTR.runReason] ?? '-')} ms=${ms}`;
}

function consoleTelemetry(write: (line: string) => void): TelemetryHook {
  return {
    async span(name, initial, fn) {
      const attrs: Attributes = { ...initial };
      const started = Date.now();
      try {
        return await fn(handle(attrs));
      } finally {
        if (name === SPAN.hop) write(hopLine(attrs, Date.now() - started));
      }
    },
    event: () => {},
    metric: () => {},
  };
}

interface Check { ok: boolean; reason: string }

function textChecks(text: string, expected: { equals?: string; contains?: string; matches?: string }): Check[] {
  const checks: Check[] = [];
  if (expected.equals !== undefined) checks.push({ ok: text === expected.equals, reason: 'equals' });
  if (expected.contains !== undefined) checks.push({ ok: text.includes(expected.contains), reason: 'contains' });
  if (expected.matches !== undefined) {
    let ok = false;
    try { ok = new RegExp(expected.matches).test(text); } catch { /* an invalid pattern never matches */ }
    checks.push({ ok, reason: 'matches' });
  }
  return checks;
}

function toScore(metric: string, checks: Check[], member?: string): Score {
  const failed = checks.filter((c) => !c.ok).map((c) => c.reason);
  return { metric, value: failed.length ? 0 : 1, ...(member ? { member } : {}), ...(failed.length ? { reason: `failed: ${failed.join(', ')}` } : {}) };
}

/** The last hop of a member that the topology did not abandon. */
const lastHop = (record: HopRecord[], member: string): HopRecord | undefined =>
  record.filter((h) => h.member === member && !h.abandoned).at(-1);

function scoreHook(read: PrototypeHostOptions['read']): ScoreHook {
  return {
    async score(evalCase: EvalCase, result: SystemResult): Promise<Score[]> {
      const scores: Score[] = [];
      const { output, members } = evalCase.expected ?? {};
      if (output) scores.push(toScore('expected.output', textChecks(result.output, output)));
      for (const [member, expected] of Object.entries(members ?? {})) {
        const hop = lastHop(result.record, member);
        const checks: Check[] = [{ ok: !!hop, reason: 'called' }];
        if (hop && expected.status !== undefined) checks.push({ ok: hop.status === expected.status, reason: 'status' });
        if (hop && (expected.contains !== undefined || expected.matches !== undefined)) {
          const text = hop.outputRef && read ? await read(hop.outputRef) : undefined;
          checks.push(...(text === undefined ? [{ ok: false, reason: 'output unavailable' }] : textChecks(text, expected)));
        }
        scores.push(toScore('expected.member', checks, member));
      }
      return scores;
    },
  };
}

/**
 * The host for prototypes and tests: every call allowed, no tokens, no content checks, one line per hop, and scoring
 * limited to the `expected` fields of a case. The readiness gate refuses it on a production tier.
 */
export function prototypeHost(options: PrototypeHostOptions = {}): Host {
  const write = options.write ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  return {
    name: 'prototype',
    tier: 'prototype',
    gate: {
      allow: async () => ({ effect: 'allow' }),
      token: async () => undefined,
      check: async () => ({ action: 'allow' }),
    },
    telemetry: options.quiet ? noopTelemetry : consoleTelemetry(write),
    score: scoreHook(options.read),
  };
}
