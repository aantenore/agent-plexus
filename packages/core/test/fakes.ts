import type { Attributes, GateCheck, GateDecision, GateHook, GateVerdict, Host } from '../src/hooks.ts';
import { deadlineBy, Ledger, openBounds } from '../src/ledger.ts';
import type { MemberCallEnv, RunState } from '../src/member-call.ts';
import type { Execution, ExecutionPort, MemberCallContext, MemberPort } from '../src/ports.ts';
import type { AgentEntry, Bounds, Caller, MemberResult, RunContext } from '../src/shapes.ts';
import { resolveLimits, type SystemLimits } from '../src/system-limits.ts';

export const entry = (id: string, extra: Partial<AgentEntry> = {}): AgentEntry => ({
  id, name: id, description: `${id} member`, skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: false }, ...extra,
});

export type Resume = (taskRef: string, input: unknown, ctx: MemberCallContext) => Promise<MemberResult> | MemberResult;

export type Invoke = (input: unknown, ctx: MemberCallContext) => Promise<MemberResult> | MemberResult;

export const completed = (output: string, extra: Partial<MemberResult> = {}): MemberResult => ({ status: 'completed', output, ...extra });

export function member(id: string, invoke: Invoke, extra: Partial<AgentEntry> = {}): MemberPort {
  return { name: id, describe: async () => entry(id, extra), invoke: async (input, ctx) => invoke(input, ctx) };
}

export interface SpanLog { name: string; attrs: Attributes }

export interface Harness {
  host: Host;
  log: string[];
  spans: SpanLog[];
  events: { name: string; attrs: Attributes }[];
}

export interface HostOptions {
  tier?: Host['tier'];
  allow?: (q: Parameters<GateHook['allow']>[0]) => Promise<GateDecision> | GateDecision;
  token?: GateHook['token'];
  check?: (c: GateCheck) => Promise<GateVerdict> | GateVerdict;
}

/** A host that logs the order of gate calls and keeps every span's final attributes. */
export function recordingHost(o: HostOptions = {}, log: string[] = []): Harness {
  const spans: SpanLog[] = [];
  const events: Harness['events'] = [];
  const host: Host = {
    name: 'test-host',
    tier: o.tier ?? 'prototype',
    gate: {
      allow: async (q) => { log.push('allow'); return o.allow ? o.allow(q) : { effect: 'allow' }; },
      token: async (caller, audience) => { log.push('token'); return o.token ? o.token(caller, audience) : undefined; },
      check: async (c) => { log.push(`check:${c.stage}`); return o.check ? o.check(c) : { action: 'allow' }; },
    },
    telemetry: {
      async span(name, attrs, fn) {
        const own: Attributes = { ...attrs };
        spans.push({ name, attrs: own });
        return fn({ set: (more) => { Object.assign(own, more); }, event: (name, attrs = {}) => { events.push({ name, attrs }); } });
      },
      event: (name, attrs) => { events.push({ name, attrs }); },
      metric: () => {},
    },
  };
  return { host, log, spans, events };
}

export interface FakeExecution extends ExecutionPort {
  texts: Map<string, string>;
  steps: string[];
  /** Kept values per run key. */
  kept: Map<string, Map<string, unknown>>;
  /** Durable mode: stored step results survive `begin`; `crash` makes the next steps die after running, storing nothing. */
  crash: boolean;
  /** Signals per run key, as JSON; a wait reads the one of its name, or nothing. */
  signals: Map<string, Map<string, string>>;
  /** Status per run key: undefined until `end` sets it; `begin` keeps the last one, as durable adapters do. */
  statuses: Map<string, string | undefined>;
  /** Run keys let go of with `release`, in order. */
  released: string[];
}

export function memoryExecution(log: string[] = [], durable = false): FakeExecution {
  const texts = new Map<string, string>();
  const steps: string[] = [];
  const kept = new Map<string, Map<string, unknown>>();
  const done = new Map<string, Map<string, string>>();
  const signals = new Map<string, Map<string, string>>();
  const statuses = new Map<string, string | undefined>();
  const released: string[] = [];
  const signalsOf = (runKey: string) => {
    const own = signals.get(runKey) ?? new Map<string, string>();
    signals.set(runKey, own);
    return own;
  };
  const port: FakeExecution = {
    name: 'memory',
    texts,
    steps,
    kept,
    crash: false,
    signals,
    statuses,
    released,
    async begin(runKey): Promise<Execution> {
      if (!statuses.has(runKey)) statuses.set(runKey, undefined);
      const values = kept.get(runKey) ?? new Map<string, unknown>();
      kept.set(runKey, values);
      const stored = done.get(runKey) ?? new Map<string, string>();
      done.set(runKey, stored);
      return {
        runKey,
        async step(name, fn) {
          log.push('step');
          steps.push(name);
          const had = durable ? stored.get(name) : undefined;
          if (had !== undefined) return JSON.parse(had);
          const value = await fn();
          if (port.crash) throw new Error('crash');
          if (durable) stored.set(name, JSON.stringify(value));
          return value;
        },
        async wait(name) { const had = signalsOf(runKey).get(name); return had === undefined ? undefined : JSON.parse(had); },
        async put(text) { const key = `t${texts.size}`; texts.set(key, text); return key; },
        async remember(key, value) { values.set(key, JSON.parse(JSON.stringify(value))); },
        async recall(key) { return values.get(key); },
        async end(status) { statuses.set(runKey, status); },
        async release() { released.push(runKey); },
      };
    },
    async signal(runKey, name, value) {
      const own = signalsOf(runKey);
      if (own.has(name)) return false;
      own.set(name, JSON.stringify(value));
      return true;
    },
    async read(key) { return texts.get(key); },
  };
  return port;
}

export interface SetupOptions {
  members?: Record<string, Invoke>;
  entries?: Record<string, Partial<AgentEntry>>;
  host?: HostOptions;
  limits?: Partial<Record<keyof SystemLimits, number | 'unbounded'>>;
  bounds?: Partial<Bounds>;
  caller?: Caller;
  sessionId?: string;
  signal?: AbortSignal;
  now?: () => number;
  /** Resume functions, by member id; a member without one cannot continue remote work. */
  resumes?: Record<string, Resume>;
  /** A journal shared with an earlier setup, as a durable adapter would be after a restart. */
  execution?: FakeExecution;
}

export interface Setup extends Harness {
  env: MemberCallEnv;
  run: RunState;
  execution: FakeExecution;
}

/** A member-call environment over fake members, a recording host and an in-memory journal. */
export async function setup(o: SetupOptions = {}): Promise<Setup> {
  const harness = recordingHost(o.host);
  const execution = o.execution ?? memoryExecution(harness.log);
  const values = resolveLimits(undefined);
  const limits = { ...values, ...o.limits } as SystemLimits;
  const members = new Map(Object.entries(o.members ?? { m: () => completed('ok') }).map(([id, fn]) => {
    const port = member(id, (i, c) => { harness.log.push('invoke'); return fn(i, c); }, o.entries?.[id]);
    const resume = o.resumes?.[id];
    if (resume) port.resume = async (ref, input, c) => { harness.log.push('resume'); return resume(ref, input, c); };
    return [id, port] as const;
  }));
  const ctx: RunContext = {
    runId: 'run-1', system: 'sys', ...(o.sessionId ? { sessionId: o.sessionId } : {}), ...(o.caller ? { caller: o.caller } : {}), ...(o.signal ? { signal: o.signal } : {}),
    ...(o.bounds ? { bounds: { deadlineAt: new Date(Date.now() + 60_000).toISOString(), hops: 0, maxHops: 3, ...o.bounds } } : {}),
  };
  const now = (o.now ?? Date.now)();
  const bounds = openBounds(ctx, limits, now);
  const run: RunState = {
    ctx, rootRunId: 'root-1', ledger: new Ledger(bounds, o.now, deadlineBy(ctx, limits, now)), execution: await execution.begin('run-1'),
    steps: 0, recent: [], records: [],
  };
  const env: MemberCallEnv = {
    system: 'sys', host: harness.host, members, limits, entry: (id) => members.get(id)!.describe(), ...(o.now ? { now: o.now } : {}),
  };
  return { ...harness, env, run, execution };
}

export const caller = (extra: Partial<Caller> = {}): Caller => ({ id: 'u1', kind: 'user', roles: [], scopes: [], credential: 'SECRET-CREDENTIAL', ...extra });
