import type { Attributes, GateCheck, GateDecision, GateHook, GateVerdict, Host } from '../src/hooks.ts';
import { deadlineBy, Ledger, openBounds } from '../src/ledger.ts';
import type { MemberCallEnv, RunState } from '../src/member-call.ts';
import type { Execution, ExecutionPort, MemberCallContext, MemberPort } from '../src/ports.ts';
import type { AgentEntry, Bounds, Caller, MemberResult, RunContext } from '../src/shapes.ts';
import { resolveLimits, type SystemLimits } from '../src/system-limits.ts';

export const entry = (id: string, extra: Partial<AgentEntry> = {}): AgentEntry => ({
  id, name: id, description: `${id} member`, skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: false }, ...extra,
});

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

export function memoryExecution(log: string[] = []): ExecutionPort & { texts: Map<string, string>; steps: string[] } {
  const texts = new Map<string, string>();
  const steps: string[] = [];
  return {
    name: 'memory',
    texts,
    steps,
    async begin(runKey): Promise<Execution> {
      return {
        runKey,
        async step(name, fn) { log.push('step'); steps.push(name); return fn(); },
        async wait() { return undefined; },
        async put(text) { const key = `t${texts.size}`; texts.set(key, text); return key; },
        async end() {},
      };
    },
    async signal() {},
    async read(key) { return texts.get(key); },
  };
}

export interface SetupOptions {
  members?: Record<string, Invoke>;
  entries?: Record<string, Partial<AgentEntry>>;
  host?: HostOptions;
  limits?: Partial<Record<keyof SystemLimits, number | 'unbounded'>>;
  bounds?: Partial<Bounds>;
  caller?: Caller;
  signal?: AbortSignal;
  now?: () => number;
}

export interface Setup extends Harness {
  env: MemberCallEnv;
  run: RunState;
  execution: ReturnType<typeof memoryExecution>;
}

/** A member-call environment over fake members, a recording host and an in-memory journal. */
export async function setup(o: SetupOptions = {}): Promise<Setup> {
  const harness = recordingHost(o.host);
  const execution = memoryExecution(harness.log);
  const values = resolveLimits(undefined);
  const limits = { ...values, ...o.limits } as SystemLimits;
  const members = new Map(Object.entries(o.members ?? { m: () => completed('ok') }).map(([id, fn]) => [id, member(id, (i, c) => { harness.log.push('invoke'); return fn(i, c); }, o.entries?.[id])]));
  const ctx: RunContext = {
    runId: 'run-1', system: 'sys', ...(o.caller ? { caller: o.caller } : {}), ...(o.signal ? { signal: o.signal } : {}),
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
