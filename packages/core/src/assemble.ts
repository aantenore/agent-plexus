import { randomUUID } from 'node:crypto';
import type { AdapterContext, Fills, FillTypes, Tier } from './adapter.ts';
import { loadConditionFns, matchesCondition } from './condition.ts';
import type { ResolvedConfig } from './config.ts';
import type { Host } from './hooks.ts';
import { deadlineBy, deadlineMs, Ledger, openBounds } from './ledger.ts';
import { memberCall, type MemberCallEnv, type RunState } from './member-call.ts';
import { ATTR, METRIC, SPAN } from './names.ts';
import type {
  AgentRouterPort, AttributionPort, BoundTopology, ExecutionPort, MemberPort, RecordSource, RegistryPort, RouteRequest, RunScope,
  TopologyPort,
} from './ports.ts';
import { prototypeHost, noopTelemetry } from './prototype-host.ts';
import { readinessFindings, type Finding } from './readiness.ts';
import { createAdapter, loadDescriptor, type DescriptorLoader } from './resolve.ts';
import type {
  AgentEntry, Attribution, EvalCase, HopRecord, MemberResult, RouteDecision, RunContext, RunInput, Score, SystemResult,
} from './shapes.ts';
import { DEFAULT_ROUTER } from './topology-check.ts';
import { limitNumber, type Env } from './system-limits.ts';
import { errorMessage, withoutCredential } from './util.ts';

/** Longest run id a caller may provide. */
const MAX_RUN_ID = 128;

export interface AssembleOptions {
  /** Overrides the config's host; without either, the prototype host. */
  host?: Host;
  /** Directory relative paths resolve against (default: the config's). */
  cwd?: string;
  env?: Env;
  /** Finds adapter descriptors (default: `@agent-plexus/adapter-<name>` or a module path). For tests. */
  resolveAdapter?: DescriptorLoader;
  /** The default prototype host prints no hop lines (ignored when a host is given or configured). */
  quiet?: boolean;
}

/** An assembled system: run it, ask for its members, attribute a failure, check its readiness. */
export interface System {
  name: string;
  tier: Tier;
  /**
   * Runs the topology once. `ctx.runId` is used when the caller provides one (a non-empty string of at most 128
   * characters; anything else is replaced by a generated id). The caller is responsible for its uniqueness.
   */
  run(input: RunInput, ctx?: Partial<RunContext>): Promise<SystemResult>;
  entries(): Promise<AgentEntry[]>;
  attribute(result: SystemResult, scores?: Score[]): Promise<Attribution[]>;
  score(evalCase: EvalCase, result: SystemResult): Promise<Score[]>;
  check(): Promise<Finding[]>;
  close(): Promise<void>;
}

const failed = (code: string, layer: string, detail: string): MemberResult =>
  ({ status: 'failed', output: '', reason: { code, layer, detail } });

/** Creates the members, ports and host of a resolved config and returns the system that runs them. */
export async function assemble(config: ResolvedConfig, opts: AssembleOptions = {}): Promise<System> {
  const cwd = opts.cwd ?? config.cwd;
  const env = opts.env ?? process.env;
  const load = opts.resolveAdapter ?? loadDescriptor;
  const limits = config.limits;
  const used: { path: string; descriptor: Awaited<ReturnType<typeof createAdapter>>['descriptor']; options: Record<string, unknown> }[] = [];
  const instances: unknown[] = [];

  async function create<F extends Fills>(fills: F, ref: { adapter: string; options?: Record<string, unknown> }, ctx: AdapterContext, path: string): Promise<FillTypes[F]> {
    const made = await createAdapter(load, fills, ref, ctx, path);
    used.push({ path, descriptor: made.descriptor, options: made.options });
    instances.push(made.instance);
    return made.instance;
  }

  let execution: ExecutionPort | undefined;
  const host: Host = opts.host
    ?? (config.host ? await create('Host', config.host, { system: config.name, name: 'host', cwd, env, telemetry: noopTelemetry }, '$.host') : prototypeHost({ ...(opts.quiet ? { quiet: true } : {}), read: async (key) => execution?.read?.(key) }));

  const entryCache = new Map<string, Promise<AgentEntry>>();
  const members = new Map<string, MemberPort>();
  const entry = (id: string): Promise<AgentEntry> => {
    let cached = entryCache.get(id);
    if (!cached) {
      cached = members.get(id)!.describe().then((e) => ({ ...e, id }));
      cached.catch(() => entryCache.delete(id));
      entryCache.set(id, cached);
    }
    return cached;
  };
  const entries = () => Promise.all([...members.keys()].map(entry));
  const context = (name: string): AdapterContext => ({ system: config.name, name, cwd, env, telemetry: host.telemetry, members: entries });

  for (const [id, ref] of Object.entries(config.members)) members.set(id, await create('MemberPort', ref, context(id), `$.members.${id}`));
  const registry: RegistryPort | undefined = config.ports.registry ? await create('RegistryPort', config.ports.registry, context('registry'), '$.ports.registry') : undefined;
  const routers = new Map<string, AgentRouterPort>();
  for (const [name, ref] of Object.entries(config.ports.routers)) routers.set(name, await create('AgentRouterPort', ref, context(name), `$.ports.router${name === DEFAULT_ROUTER ? '' : `.${name}`}`));
  const topology: TopologyPort = await create('TopologyPort', config.ports.topology, context('topology'), '$.ports.topology');
  execution = await create('ExecutionPort', config.ports.execution, context('execution'), '$.ports.execution');
  const attribution: AttributionPort = await create('AttributionPort', config.ports.attribution, context('attribution'), '$.ports.attribution');
  const journal: ExecutionPort = execution;

  const fns = await loadConditionFns(config.topology, cwd);
  let bound: BoundTopology | undefined;
  let bindError: string | undefined;
  try {
    bound = await topology.bind(config.topology, { system: config.name, members: [...members.keys()] });
  } catch (err) {
    bindError = errorMessage(err);
  }

  const callEnv: MemberCallEnv = { system: config.name, host, members, entry, limits };
  const history: { rootRunId: string; record: HopRecord[] }[] = [];
  const source: RecordSource = {
    name: 'memory',
    records: async (rootRunId) => history.filter((h) => h.rootRunId === rootRunId).flatMap((h) => h.record),
  };

  async function candidatesOf(request: RouteRequest): Promise<AgentEntry[]> {
    if (!registry) throw new Error('no registry configured');
    const found = Array.isArray(request.candidates)
      ? (await Promise.all(request.candidates.map((id) => registry.get(id)))).filter((e): e is AgentEntry => !!e)
      : await registry.list(request.candidates);
    return found.slice(0, limitNumber(limits.maxCandidates));
  }

  /** A route that chose nobody is a hop of its own, so attribution can see it; it is not a step. */
  function recordNoRoute(state: RunState, node: string, decision: RouteDecision): void {
    state.records.push({
      hopId: randomUUID(), member: '', node, rootRunId: state.rootRunId, hops: state.ledger.bounds.hops + 1,
      startedAt: new Date().toISOString(), durationMs: 0, status: 'stopped', reason: { code: 'rejected', layer: 'routing' },
      route: { ...(decision.ranked ? { ranked: decision.ranked } : {}) },
    });
  }

  function scopeOf(state: RunState, input: RunInput): RunScope {
    const route = (request: RouteRequest): Promise<RouteDecision> =>
      host.telemetry.span(SPAN.route, { [ATTR.layer]: 'routing', [ATTR.system]: config.name, [ATTR.nodePath]: request.node }, async (span) => {
        let decision: RouteDecision;
        try {
          const router = routers.get(request.router ?? DEFAULT_ROUTER);
          if (!router) throw new Error(`router "${request.router ?? DEFAULT_ROUTER}" is not configured`);
          const candidates = await candidatesOf(request);
          const asked = await router.route(
            { input: request.input, candidates, ...(state.ctx.caller ? { caller: withoutCredential(state.ctx.caller) } : {}), bounds: state.ledger.bounds },
            { ...state.ctx, ...(state.ctx.caller ? { caller: withoutCredential(state.ctx.caller) } : {}) },
          );
          decision = asked.member !== undefined && !candidates.some((c) => c.id === asked.member) ? { reason: 'router chose a member outside the candidates' } : asked;
        } catch (err) {
          decision = { reason: errorMessage(err) };
        }
        span.set({ [ATTR.routeChoice]: decision.member ?? '' });
        if (decision.member === undefined) recordNoRoute(state, request.node, decision);
        return decision;
      });
    const { caller } = state.ctx;
    return {
      ctx: { ...state.ctx, ...(caller ? { caller: withoutCredential(caller) } : {}) },
      input,
      limits: {
        maxParallel: limitNumber(limits.maxParallel),
        maxIterations: limitNumber(limits.maxIterations),
        maxHandoffs: limitNumber(limits.maxHandoffs),
      },
      call: (member, text, options) => memberCall(callEnv, state, member, text, options),
      route,
      matches: (condition, result) => matchesCondition(condition, result, fns),
      abandon: (hopId) => {
        const record = state.records.find((r) => r.hopId === hopId);
        if (record) record.abandoned = true;
      },
    };
  }

  async function execute(input: RunInput, ctx: RunContext, rootRunId: string): Promise<SystemResult> {
    const record = (result: MemberResult, records: HopRecord[] = []): SystemResult => ({ ...result, runId: ctx.runId, record: records });
    let run;
    try {
      run = await journal.begin(ctx.runId);
    } catch (err) {
      return record(failed('error', 'execution', errorMessage(err)));
    }
    const now = Date.now();
    const ledger = new Ledger(openBounds(ctx, limits, now), Date.now, deadlineBy(ctx, limits, now));
    const state: RunState = { ctx, rootRunId, ledger, execution: run, steps: 0, recent: [], records: [] };
    let result: MemberResult;
    if (!bound) result = failed('error', 'topology', bindError ?? 'topology is not bound');
    else if (Date.now() >= deadlineMs(ledger.bounds)) result = { status: 'stopped', output: '', reason: { code: 'timeout', layer: 'topology' } };
    else {
      try {
        result = await bound.run(input, scopeOf(state, input));
      } catch (err) {
        result = failed('error', 'topology', errorMessage(err));
      }
    }
    try { await run.end(result.status); } catch { /* the result stands */ }
    const records = [...state.records].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    history.push({ rootRunId, record: records });
    if (history.length > limitNumber(limits.historyRuns)) history.shift();
    return record(result, records);
  }

  return {
    name: config.name,
    tier: config.tier,
    run(input, partial = {}) {
      const runId = typeof partial.runId === 'string' && partial.runId.length > 0 && partial.runId.length <= MAX_RUN_ID ? partial.runId : randomUUID();
      const ctx: RunContext = { ...partial, runId, system: config.name };
      return host.telemetry.span(SPAN.run, { [ATTR.layer]: 'topology', [ATTR.system]: config.name }, async (span) => {
        const result = await execute(input, ctx, partial.lineage?.rootRunId ?? runId);
        span.set({ [ATTR.runStatus]: result.status, ...(result.reason ? { [ATTR.runReason]: result.reason.code } : {}) });
        return result;
      });
    },
    entries,
    async attribute(result, scores = []) {
      const found = await attribution.attribute({ record: result.record.slice(0, limitNumber(limits.maxRecords)), result, scores, source });
      for (const a of found) host.telemetry.metric(METRIC.attributions, 1, { [ATTR.layer]: a.layer, [ATTR.member]: a.member });
      return found;
    },
    async score(evalCase, result) {
      return host.score ? host.score.score(evalCase, result) : [];
    },
    async check() {
      const described: AgentEntry[] = [];
      const problems: Finding[] = [];
      for (const id of members.keys()) {
        try { described.push(await entry(id)); } catch (err) {
          problems.push({ severity: 'fail', path: `$.members.${id}`, message: `member cannot describe itself: ${errorMessage(err)}` });
        }
      }
      let registryIds: string[] | undefined;
      let registryError: string | undefined;
      if (registry) {
        try { registryIds = (await registry.list()).map((e) => e.id); } catch (err) { registryError = errorMessage(err); }
      }
      const findings = readinessFindings({
        config, host, adapters: used, entries: described,
        topologyKinds: topology.kinds, routers: [...routers.keys()],
        ...(registryIds ? { registryIds } : {}), ...(registryError ? { registryError } : {}), ...(bindError ? { bindError } : {}),
      });
      return [...findings, ...problems];
    },
    async close() {
      await Promise.allSettled(instances.map(async (i) => (i as { close?: () => unknown }).close?.()));
    },
  };
}
