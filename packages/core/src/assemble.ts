import { randomUUID } from 'node:crypto';
import type { AdapterContext, Fills, FillTypes, Tier } from './adapter.ts';
import { loadConditionFns, matchesCondition } from './condition.ts';
import type { ResolvedConfig } from './config.ts';
import type { CancelQuestion, GateAnswer, Host, ResumeQuestion } from './hooks.ts';
import { isRunBusy } from './errors.ts';
import { deadlineBy, deadlineMs, Ledger, openBounds, spentTotals, type SpentTotals } from './ledger.ts';
import {
  cancelWait, memberCall, nextStepKey, replyName, replyWait, resumeReply, RUN_KEYS, waitingCall, waitRef, waitToken, type MemberCallEnv, type RunState,
  type WaitingCall,
} from './member-call.ts';
import { ATTR, EVENT, METRIC, SPAN } from './names.ts';
import type {
  AgentRouterPort, AttributionPort, BoundTopology, Execution, ExecutionPort, MemberPort, RecordSource, RegistryPort, RouteRequest,
  RunScope, TopologyPort,
} from './ports.ts';
import { expectedScores, prototypeHost, noopTelemetry } from './prototype-host.ts';
import { readinessFindings, type Finding } from './readiness.ts';
import { createAdapter, pluginLoader, type DescriptorLoader } from './resolve.ts';
import {
  callerIdentity, inputText, isRunInput, sameIdentity, type AgentEntry, type Attribution, type CallerIdentity, type EvalCase,
  type Caller, type HopRecord, type Lineage, type MemberResult, type ResumeReply, type RouteDecision, type RunContext, type RunInput, type RunStatus,
  type Score, type SystemResult, type Usage,
} from './shapes.ts';
import { DEFAULT_ROUTER } from './topology-check.ts';
import { limitNumber, type Env } from './system-limits.ts';
import { errorMessage, isPlainObject, withoutCredential } from './util.ts';

/** Longest run id a caller may provide. */
const MAX_RUN_ID = 128;

const isRunId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_RUN_ID;

const lineageOf = (value: unknown): Lineage | undefined =>
  isPlainObject(value) && typeof value.rootRunId === 'string' && typeof value.parentRunId === 'string'
    ? { rootRunId: value.rootRunId, parentRunId: value.parentRunId }
    : undefined;

/** A kept `run:owner`: an identity, `null` for a run started without a caller, undefined when it is not a valid one. */
function ownerOf(value: unknown): CallerIdentity | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value) || typeof value.id !== 'string' || (value.kind !== 'user' && value.kind !== 'agent')) return undefined;
  const actors = Array.isArray(value.actors)
    ? value.actors.filter((a): a is { id: string; kind: 'user' | 'agent' } => isPlainObject(a) && typeof a.id === 'string' && (a.kind === 'user' || a.kind === 'agent'))
    : undefined;
  return callerIdentity({ id: value.id, kind: value.kind, ...(typeof value.name === 'string' ? { name: value.name } : {}), ...(actors ? { actors } : {}) });
}

/** Same text and same parts: a string and `{ text }` with that string are the same input. */
const sameInput = (a: RunInput, b: RunInput): boolean => {
  const parts = (i: RunInput) => JSON.stringify(typeof i === 'string' ? [] : i.parts ?? []);
  return inputText(a) === inputText(b) && parts(a) === parts(b);
};

/** A kept `run:cancelled`: who cancelled the run and why, or undefined when the run was not cancelled. */
function cancelMarker(value: unknown): { by?: string; reason?: string } | undefined {
  if (!isPlainObject(value)) return undefined;
  return { ...(typeof value.by === 'string' ? { by: value.by } : {}), ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
}

/** What the run had kept when an invocation began it: its input and its owner (undefined for a new run). */
interface Kept {
  input: unknown;
  owner: unknown;
}

/**
 * How a run starts: its input and context and the wait it reads a reply for, or why it cannot start. A refusal leaves
 * the run as it was: the invocation lets go of it without a status, and only a run that kept nothing ends `failed`.
 */
type Opening = { input: RunInput; ctx: RunContext; resuming?: WaitingCall } | { refused: MemberResult };

/**
 * Runs held by an invocation in this process, per journal: one invocation per run at a time. Keyed by the execution
 * adapter instance rather than the system, so systems that share one journal instance share the hold too; systems on
 * separate instances of one store rely on the adapter's own hold (`begin` rejecting with `RUN_BUSY`).
 */
const holds = new WeakMap<ExecutionPort, Set<string>>();

export interface AssembleOptions {
  /** Overrides the config's host; without either, the prototype host. */
  host?: Host;
  /** Directory relative paths resolve against (default: the config's). */
  cwd?: string;
  env?: Env;
  /** Finds adapter descriptors (default: `@agent-plexus/adapters/<name>` or a module path). For tests. */
  resolveAdapter?: DescriptorLoader;
  /** The default prototype host prints no hop lines (ignored when a host is given or configured). */
  quiet?: boolean;
}

/** Who cancels a run and why, and a signal that stops the cancel before it changes the run. */
export interface CancelOptions {
  /** The caller that cancels, asked of the host's gate as `caller` (never with its credential). */
  by?: Caller;
  /** Kept with the run as the `detail` of its stop reason; never passed to a member. */
  reason?: string;
  signal?: AbortSignal;
}

/** An assembled system: run it, ask for its members, attribute a failure, check its readiness. */
export interface System {
  name: string;
  tier: Tier;
  /**
   * Runs the topology once. `ctx.runId` is used when the caller provides one (a non-empty string of at most 128
   * characters; anything else is replaced by a generated id). The caller is responsible for its uniqueness. With the
   * id of a run the journal knows, the run continues (completed steps replay) only with the same input, and only for
   * its owner or a caller the host's gate lets `resume` it.
   */
  run(input: RunInput, ctx?: Partial<RunContext>): Promise<SystemResult>;
  /**
   * Answers a run that ended `waiting` and runs its topology again under the same run id, with the input kept when it
   * started: completed steps replay from the journal and the waiting call reads the reply. `input` answers a member
   * that waits for input, `approved` the host's `ask`; `wait`, when given, must be the token of the wait the run keeps
   * (`SystemResult.wait.token`), so a late or repeated reply cannot answer a later wait. Like `run`, a new invocation:
   * deadline and budget come from `ctx` and the limits, and `ctx.caller` is who resumes. The host's gate is asked
   * `resume` first (with the run's owner); only `allow` delivers the reply. One reply per wait: the first delivered
   * wins. Across processes it needs a durable execution adapter.
   */
  resume(runId: string, reply: ResumeReply, ctx?: Partial<RunContext>): Promise<SystemResult>;
  /**
   * Closes a run that is not over: a waiting run, or one an earlier invocation left unfinished. The member it waits on
   * is asked to cancel its remote task (best effort, as the core does for an abandoned call), and the run ends
   * `stopped` with the code `cancelled`, kept with `run:cancelled`; a `run` or `resume` of it is refused afterwards.
   * The host's gate is asked `cancel` first (with the run's owner): the prototype host and the agent-layers host allow
   * the owner only. Refused without changing the run:
   * `not_found` (the journal has no such run), `conflict` (it already completed, failed or stopped), `denied` and
   * `needs_input` (the gate), and `error` for a run another invocation holds. Cancelling a cancelled run returns its
   * result again. Needs a durable execution adapter to be seen across processes.
   */
  cancel(runId: string, opts?: CancelOptions): Promise<SystemResult>;
  entries(): Promise<AgentEntry[]>;
  attribute(result: SystemResult, scores?: Score[]): Promise<Attribution[]>;
  score(evalCase: EvalCase, result: SystemResult): Promise<Score[]>;
  check(): Promise<Finding[]>;
  close(): Promise<void>;
}

const failed = (code: string, layer: string, detail: string): MemberResult =>
  ({ status: 'failed', output: '', reason: { code, layer, detail } });

/**
 * What an invocation spent, from its own hop records: replayed calls were spent by an earlier invocation and are left
 * out. A dimension no record reports is absent.
 */
function invocationTotals(records: readonly HopRecord[]): { usage?: Usage; costUsd?: number } {
  let usage: Usage | undefined;
  let costUsd: number | undefined;
  for (const r of records) {
    if (r.replayed) continue;
    if (r.usage) usage = { inputTokens: (usage?.inputTokens ?? 0) + r.usage.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + r.usage.outputTokens };
    if (r.costUsd !== undefined) costUsd = (costUsd ?? 0) + r.costUsd;
  }
  return { ...(usage ? { usage } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}

/** Creates the members, ports and host of a resolved config and returns the system that runs them. */
export async function assemble(config: ResolvedConfig, opts: AssembleOptions = {}): Promise<System> {
  const cwd = opts.cwd ?? config.cwd;
  const env = opts.env ?? process.env;
  const load = opts.resolveAdapter ?? pluginLoader(config.plugins);
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

  // A member's description, kept for `limits.system.describeTtlMs` from when it was asked (0: asked every time), so a
  // long-running system sees a member change what it offers; one that could not describe itself is asked again at once.
  const entryCache = new Map<string, { entry: Promise<AgentEntry>; askedAt: number }>();
  const members = new Map<string, MemberPort>();
  const entry = (id: string): Promise<AgentEntry> => {
    const cached = entryCache.get(id);
    if (cached && Date.now() - cached.askedAt < limitNumber(limits.describeTtlMs)) return cached.entry;
    const asked = members.get(id)!.describe().then((e) => ({ ...e, id }));
    asked.catch(() => { if (entryCache.get(id)?.entry === asked) entryCache.delete(id); });
    entryCache.set(id, { entry: asked, askedAt: Date.now() });
    return asked;
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
    text: async (key) => execution?.read?.(key),
  };

  async function candidatesOf(request: RouteRequest): Promise<AgentEntry[]> {
    if (!registry) throw new Error('no registry configured');
    const found = Array.isArray(request.candidates)
      ? (await Promise.all(request.candidates.map((id) => registry.get(id)))).filter((e): e is AgentEntry => !!e)
      : await registry.list(request.candidates);
    return found.slice(0, limitNumber(limits.maxCandidates));
  }

  /** Reports a journal write that failed: the key (or `end`, `release`) and the error, never the value. */
  const writeFailed = (key: string, err: unknown): void =>
    host.telemetry.event(EVENT.writeFailed, { [ATTR.layer]: 'execution', [ATTR.system]: config.name, [ATTR.executionKey]: key, [ATTR.errorMessage]: errorMessage(err) });

  /** Keeps a run value; a write that fails is reported and the run goes on, though it may not be resumable. Whether it succeeded. */
  async function keep(run: Execution, key: string, value: unknown): Promise<boolean> {
    try {
      await run.remember(key, value);
      return true;
    } catch (err) {
      writeFailed(key, err);
      return false;
    }
  }

  /** Ends the run with a status; a failure is reported and the result stands. */
  async function end(run: Execution, status: RunStatus): Promise<void> {
    try {
      await run.end(status);
    } catch (err) {
      writeFailed('end', err);
    }
  }

  /** Lets go of the run without a status; a failure is reported and the result stands. */
  async function release(run: Execution): Promise<void> {
    try {
      await run.release?.();
    } catch (err) {
      writeFailed('release', err);
    }
  }

  /** The wait a waiting result names, else the latest the run recorded (reported: the result named none of them). */
  function keptWait(result: MemberResult, waits: readonly WaitingCall[] = []): WaitingCall | undefined {
    const token = result.wait?.token;
    const named = token === undefined ? undefined : waits.find((w) => waitToken(w) === token);
    if (named) return named;
    const latest = waits.at(-1);
    if (latest) host.telemetry.event(EVENT.waitInferred, { [ATTR.layer]: 'execution', [ATTR.system]: config.name, [ATTR.member]: latest.member });
    return latest;
  }

  /**
   * A route that chose nobody, or that failed, is a hop of its own, so attribution can see it; it is not a step. A route
   * that chose nobody writes none when `optional`; a failed one always does.
   */
  function recordNoRoute(state: RunState, node: string, decision: RouteDecision): void {
    state.records.push({
      hopId: randomUUID(), member: '', node, rootRunId: state.rootRunId, hops: state.ledger.bounds.hops + 1,
      startedAt: new Date().toISOString(), durationMs: 0,
      ...(decision.failed
        ? { status: 'failed' as const, reason: { code: 'error', layer: 'routing', ...(decision.reason ? { detail: decision.reason } : {}) } }
        : { status: 'stopped' as const, reason: { code: 'rejected', layer: 'routing' } }),
      route: { ...(decision.ranked ? { ranked: decision.ranked } : {}) },
    });
  }

  function scopeOf(state: RunState, input: RunInput): RunScope {
    // Throws when routing fails, so the failure is never journaled as a decision.
    const decide = async (request: RouteRequest): Promise<RouteDecision> => {
      const router = routers.get(request.router ?? DEFAULT_ROUTER);
      if (!router) throw new Error(`router "${request.router ?? DEFAULT_ROUTER}" is not configured`);
      const candidates = await candidatesOf(request);
      const asked = await router.route(
        { input: request.input, candidates, ...(state.ctx.caller ? { caller: withoutCredential(state.ctx.caller) } : {}), bounds: state.ledger.bounds },
        { ...state.ctx, ...(state.ctx.caller ? { caller: withoutCredential(state.ctx.caller) } : {}) },
      );
      if (asked.member !== undefined && !candidates.some((c) => c.id === asked.member)) throw new Error('router chose a member outside the candidates');
      return asked;
    };
    const routes = new Map<string, number>();
    const route = (request: RouteRequest): Promise<RouteDecision> => {
      // A journal step, so a replay takes the path it took, whatever the router would answer now. Keyed by node path.
      const key = nextStepKey(routes, 'route', request.node);
      return host.telemetry.span(SPAN.route, { [ATTR.layer]: 'routing', [ATTR.system]: config.name, [ATTR.nodePath]: request.node }, async (span) => {
        let decision: RouteDecision;
        try {
          decision = await state.execution.step(key, () => decide(request));
        } catch (err) {
          decision = { reason: errorMessage(err), failed: true };
        }
        span.set({ [ATTR.routeChoice]: decision.member ?? '' });
        if (decision.failed || (decision.member === undefined && !request.optional)) recordNoRoute(state, request.node, decision);
        return decision;
      });
    };
    // With registry.requireListed, one registry lookup per member and run.
    const listed = new Map<string, Promise<boolean>>();
    const env: MemberCallEnv = registry && config.registry.requireListed
      ? {
        ...callEnv,
        listed: (id) => {
          let found = listed.get(id);
          if (!found) {
            found = registry.get(id).then((e) => e !== undefined);
            listed.set(id, found);
          }
          return found;
        },
      }
      : callEnv;
    const { caller } = state.ctx;
    return {
      ctx: { ...state.ctx, ...(caller ? { caller: withoutCredential(caller) } : {}) },
      input,
      limits: {
        maxParallel: limitNumber(limits.maxParallel),
        maxIterations: limitNumber(limits.maxIterations),
        maxHandoffs: limitNumber(limits.maxHandoffs),
      },
      call: (member, text, options) => memberCall(env, state, member, text, options),
      route,
      matches: (condition, result) => matchesCondition(condition, result, fns),
      abandon: (hopId) => {
        const record = state.records.find((r) => r.hopId === hopId);
        if (record) record.abandoned = true;
        // A call that ended waiting on a remote task: the member is asked to cancel it, best effort, without waiting.
        const cancel = state.tasks?.get(hopId);
        if (cancel) {
          state.tasks!.delete(hopId);
          void cancel();
        }
      },
    };
  }

  /** The description of the member a run waits on, for the gate; undefined when there is none or it cannot describe itself. */
  async function waitingMember(waiting: WaitingCall | undefined): Promise<AgentEntry | undefined> {
    if (!waiting || !members.has(waiting.member)) return undefined;
    try {
      return await entry(waiting.member);
    } catch {
      return undefined; // asked without the member
    }
  }

  /** Undefined when the gate allows the question; otherwise the result of the refused invocation: `denied`, or `waiting` on `ask`. */
  async function gateRefusal(question: ResumeQuestion | CancelQuestion): Promise<MemberResult | undefined> {
    const refusal = (code: string, status: RunStatus, detail?: string): MemberResult =>
      ({ status, output: '', reason: { code, layer: 'host', by: host.name, ...(detail ? { detail } : {}) } });
    try {
      const decision = await host.gate.allow(question);
      if (decision.effect === 'allow') return undefined;
      return decision.effect === 'ask' ? refusal('needs_input', 'waiting', decision.reason) : refusal('denied', 'stopped', decision.reason);
    } catch (err) {
      return refusal('denied', 'stopped', errorMessage(err));
    }
  }

  /**
   * Asks the gate whether the caller of `ctx` may continue the run that `owner` started (null: started without a
   * caller). Undefined when allowed; otherwise the result of the refused invocation: `denied`, or `waiting` on `ask`.
   */
  async function mayResume(ctx: RunContext, owner: CallerIdentity | null, waiting: WaitingCall | undefined, answer?: GateAnswer): Promise<MemberResult | undefined> {
    const member = await waitingMember(waiting);
    return gateRefusal({
      action: 'resume', runId: ctx.runId, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.caller ? { caller: withoutCredential(ctx.caller) } : {}), ...(owner ? { owner } : {}),
      ...(member ? { member } : {}), ...(answer ? { answer } : {}),
    });
  }

  function traced(ctx: RunContext, open: (run: Execution, kept: Kept) => Promise<Opening>): Promise<SystemResult> {
    return host.telemetry.span(SPAN.run, { [ATTR.layer]: 'topology', [ATTR.system]: config.name }, async (span) => {
      const result = await execute(ctx, open);
      span.set({ [ATTR.runStatus]: result.status, ...(result.reason ? { [ATTR.runReason]: result.reason.code } : {}) });
      return result;
    });
  }

  /** One invocation of a run: refused, without touching the journal, while another holds the run. */
  async function execute(start: RunContext, open: (run: Execution, kept: Kept) => Promise<Opening>): Promise<SystemResult> {
    let held = holds.get(journal);
    if (!held) holds.set(journal, (held = new Set()));
    if (held.has(start.runId)) return { ...failed('error', 'execution', `run ${start.runId} is in progress`), runId: start.runId, record: [] };
    held.add(start.runId);
    try {
      return await executeHeld(start, open);
    } finally {
      held.delete(start.runId);
    }
  }

  async function executeHeld(start: RunContext, open: (run: Execution, kept: Kept) => Promise<Opening>): Promise<SystemResult> {
    const record = (result: MemberResult, records: HopRecord[] = []): SystemResult => ({ ...result, runId: start.runId, record: records });
    let run: Execution;
    try {
      run = await journal.begin(start.runId);
    } catch (err) {
      // Another process holds the run: the same answer as for one in this process.
      return record(failed('error', 'execution', isRunBusy(err) ? `run ${start.runId} is in progress` : errorMessage(err)));
    }
    let opening: Opening;
    let fresh = false;
    let spent: SpentTotals | undefined;
    try {
      const kept: Kept = { input: await run.recall(RUN_KEYS.input), owner: await run.recall(RUN_KEYS.owner) };
      fresh = kept.input === undefined && kept.owner === undefined;
      // What earlier invocations of the run spent: the budget is the run's.
      spent = spentTotals(await run.recall(RUN_KEYS.spent));
      opening = await open(run, kept);
    } catch (err) {
      opening = { refused: failed('error', 'execution', errorMessage(err)) };
    }
    if ('refused' in opening) {
      // Nothing changes: a run that kept nothing (begun here) ends failed so the journal may drop it; any other is let go.
      if (fresh) await end(run, 'failed');
      else await release(run);
      return record(opening.refused);
    }
    const { input, ctx, resuming } = opening;
    const rootRunId = ctx.lineage?.rootRunId ?? ctx.runId;
    const now = Date.now();
    const ledger = new Ledger(openBounds(ctx, limits, now), Date.now, deadlineBy(ctx, limits, now), spent);
    const state: RunState = { ctx, rootRunId, ledger, execution: run, steps: 0, recent: [], records: [], ...(resuming ? { resuming } : {}) };
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
    // A resume answers the wait the result reports, and the result names the wait the run keeps.
    const waiting = result.status === 'waiting' ? keptWait(result, state.waits) : undefined;
    // Usage and cost are the core's totals over this invocation's calls, whatever the topology summed.
    const { wait: _wait, usage: _usage, costUsd: _costUsd, ...rest } = result;
    await state.spentWrite;
    const final: MemberResult = { ...rest, ...invocationTotals(state.records), ...(waiting ? { wait: waitRef(waiting) } : {}) };
    if (await keep(run, RUN_KEYS.waiting, waiting ?? null)) await keep(run, RUN_KEYS.status, result.status);
    await end(run, result.status);
    const records = [...state.records].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    history.push({ rootRunId, record: records });
    if (history.length > limitNumber(limits.historyRuns)) history.shift();
    return record(final, records);
  }

  /** The result of a cancelled run: `stopped`, code `cancelled`, `by` the cancelling caller and `detail` the reason. */
  const cancelledResult = (runId: string, kept: { by?: string; reason?: string }): SystemResult => ({
    status: 'stopped', output: '',
    reason: { code: 'cancelled', layer: 'execution', ...(kept.by ? { by: kept.by } : {}), ...(kept.reason ? { detail: kept.reason } : {}) },
    runId, record: [],
  });

  /** A cancel that changed nothing, and why. */
  const cancelRefused = (runId: string, code: string, detail: string, status: RunStatus = 'failed'): SystemResult =>
    ({ status, output: '', reason: { code, layer: 'execution', detail }, runId, record: [] });

  /** One cancel of a run no other invocation of this process holds. */
  async function cancelHeld(runId: string, opts: CancelOptions): Promise<SystemResult> {
    let run: Execution;
    try {
      run = await journal.begin(runId);
    } catch (err) {
      return cancelRefused(runId, 'error', isRunBusy(err) ? `run ${runId} is in progress` : errorMessage(err));
    }
    const caller = opts.by;
    try {
      const kept = await run.recall(RUN_KEYS.owner);
      if (kept === undefined && (await run.recall(RUN_KEYS.input)) === undefined) {
        // Unknown: the journal created it by `begin`, and ends it failed so it may drop it, as for a run refused at its start.
        await end(run, 'failed');
        return cancelRefused(runId, 'not_found', `run ${runId} not found`);
      }
      const owner = ownerOf(kept);
      if (owner === undefined) {
        await release(run);
        return cancelRefused(runId, 'error', `run ${runId} has no kept owner`);
      }
      const waiting = waitingCall(await run.recall(RUN_KEYS.waiting));
      const member = await waitingMember(waiting);
      const refused = await gateRefusal({
        action: 'cancel', runId, ...(caller ? { caller: withoutCredential(caller) } : {}), ...(owner ? { owner } : {}), ...(member ? { member } : {}),
      });
      if (refused) {
        await release(run);
        return { ...refused, runId, record: [] };
      }
      const already = cancelMarker(await run.recall(RUN_KEYS.cancelled));
      if (already) {
        await release(run);
        return cancelledResult(runId, already);
      }
      const status = await run.recall(RUN_KEYS.status);
      if (status === 'completed' || status === 'failed' || status === 'stopped') {
        await release(run);
        return cancelRefused(runId, 'conflict', `run ${runId} is already ${status}`);
      }
      if (opts.signal?.aborted) {
        await release(run);
        return cancelRefused(runId, 'aborted', 'the cancel was aborted before it changed the run', 'stopped');
      }
      // The marker first: a run it marks is never continued, whatever happens to the rest.
      const cancelled = { ...(caller ? { by: caller.id } : {}), ...(opts.reason ? { reason: opts.reason } : {}) };
      if (!(await keep(run, RUN_KEYS.cancelled, { at: new Date().toISOString(), ...cancelled }))) {
        await release(run);
        return cancelRefused(runId, 'error', `run ${runId} could not be cancelled`);
      }
      if (waiting) {
        const lineage = lineageOf(await run.recall(RUN_KEYS.lineage));
        const ctx: RunContext = { runId, system: config.name, ...(caller ? { caller } : {}), ...(lineage ? { lineage } : {}), ...(opts.signal ? { signal: opts.signal } : {}) };
        const now = Date.now();
        const state: RunState = {
          ctx, rootRunId: lineage?.rootRunId ?? runId, ledger: new Ledger(openBounds(ctx, limits, now), Date.now, deadlineBy(ctx, limits, now)),
          execution: run, steps: 0, recent: [], records: [],
        };
        await cancelWait(callEnv, state, waiting);
      }
      // The run waits on nothing, whatever the stop of its last invocation, and no reply is claimed for it.
      await keep(run, RUN_KEYS.waiting, null);
      await keep(run, RUN_KEYS.claimed, null);
      await keep(run, RUN_KEYS.status, 'stopped');
      await end(run, 'stopped');
      host.telemetry.event(EVENT.runCancelled, {
        [ATTR.layer]: 'execution', [ATTR.system]: config.name, [ATTR.runId]: runId, [ATTR.runStatus]: 'stopped', [ATTR.runReason]: 'cancelled',
        ...(waiting ? { [ATTR.member]: waiting.member } : {}),
      });
      return cancelledResult(runId, cancelled);
    } catch (err) {
      await release(run);
      return cancelRefused(runId, 'error', errorMessage(err));
    }
  }

  return {
    name: config.name,
    tier: config.tier,
    run(input, partial = {}) {
      const runId = isRunId(partial.runId) ? partial.runId : randomUUID();
      const ctx: RunContext = { ...partial, runId, system: config.name };
      const unkept = (): Opening => ({ refused: failed('error', 'execution', `run ${runId} could not be kept`) });
      return traced(ctx, async (run, kept): Promise<Opening> => {
        if (kept.input === undefined && kept.owner === undefined) {
          // A new run. Kept for a resume: the owner's identity, the input and the lineage, never the caller's credential.
          // Without its owner or its input the run does not start: anyone could take its id over later.
          if (!(await keep(run, RUN_KEYS.owner, ctx.caller ? callerIdentity(ctx.caller) : null)) || !(await keep(run, RUN_KEYS.input, input))) return unkept();
          if (ctx.lineage) await keep(run, RUN_KEYS.lineage, ctx.lineage);
          return { input, ctx };
        }
        // A run the journal knows: continued by its owner, or by another caller the gate lets resume it, with the same input.
        const owner = ownerOf(kept.owner);
        if (owner === undefined) return { refused: failed('error', 'execution', `run ${runId} has no kept owner`) };
        if (!sameIdentity(owner ?? undefined, ctx.caller ? callerIdentity(ctx.caller) : undefined)) {
          const refused = await mayResume(ctx, owner, waitingCall(await run.recall(RUN_KEYS.waiting)));
          if (refused) return { refused };
        }
        if (cancelMarker(await run.recall(RUN_KEYS.cancelled))) return { refused: failed('error', 'execution', `run ${runId} was cancelled`) };
        if (kept.input !== undefined && !(isRunInput(kept.input) && sameInput(kept.input, input))) {
          return { refused: failed('error', 'execution', `run ${runId} exists with a different input`) };
        }
        // A run that could not keep its input when it started keeps it now, or does not go on.
        if (kept.input === undefined && !(await keep(run, RUN_KEYS.input, input))) return unkept();
        // A reply a resume claimed before it could finish is read by the call it answers.
        const claimed = waitingCall(await run.recall(RUN_KEYS.claimed));
        return { input, ctx, ...(claimed ? { resuming: claimed } : {}) };
      });
    },
    resume(runId, reply, partial = {}) {
      const answer = resumeReply(reply);
      const asked = replyWait(reply);
      if (!isRunId(runId) || !answer || asked === false) {
        const detail = !answer ? 'invalid reply: give either input or approved' : asked === false ? 'invalid reply: wait must be a wait token' : 'invalid run id';
        return Promise.resolve({ ...failed('error', 'execution', detail), runId: String(runId), record: [] });
      }
      const ctx: RunContext = { ...partial, runId, system: config.name };
      return traced(ctx, async (run, kept): Promise<Opening> => {
        if (cancelMarker(await run.recall(RUN_KEYS.cancelled))) return { refused: failed('error', 'execution', `run ${runId} was cancelled`) };
        const waiting = waitingCall(await run.recall(RUN_KEYS.waiting));
        if (!waiting) return { refused: failed('error', 'execution', `run ${runId} is not waiting`) };
        // A reply that names its wait answers only that one: a late or repeated resume cannot answer a later wait.
        if (asked !== undefined && asked !== waitToken(waiting)) return { refused: failed('error', 'execution', `run ${runId} waits on another step`) };
        if ('input' in answer !== (waiting.kind === 'member')) {
          return { refused: failed('error', 'execution', `run ${runId} waits for ${waiting.kind === 'member' ? 'input' : 'an approval'}`) };
        }
        const { input } = kept;
        if (!isRunInput(input)) return { refused: failed('error', 'execution', `run ${runId} has no kept input`) };
        const owner = ownerOf(kept.owner);
        if (owner === undefined) return { refused: failed('error', 'execution', `run ${runId} has no kept owner`) };
        // An approval records who gave it.
        const by = ctx.caller?.id;
        const given: ResumeReply | GateAnswer = 'approved' in answer && by !== undefined ? { ...answer, by } : answer;
        // Asked before anything is delivered: a refused resume leaves the run as it was.
        const refused = await mayResume(ctx, owner, waiting, 'approved' in given ? given : undefined);
        if (refused) return { refused };
        const lineage = partial.lineage ?? lineageOf(await run.recall(RUN_KEYS.lineage));
        let delivered: boolean;
        try {
          delivered = await journal.signal(runId, replyName(waiting.key, waiting.attempt), given);
        } catch (err) {
          return { refused: failed('error', 'execution', errorMessage(err)) };
        }
        // This invocation alone holds the run, so a reply already there was delivered by an earlier resume that did not
        // finish. The first reply wins: the run goes on with it, and this one is not used.
        if (!delivered) host.telemetry.event(EVENT.replyKept, { [ATTR.layer]: 'execution', [ATTR.system]: config.name, [ATTR.member]: waiting.member });
        // The run no longer waits on that call. Should this invocation not finish, a `run` with the same id reads the claimed reply.
        await keep(run, RUN_KEYS.claimed, waiting);
        await keep(run, RUN_KEYS.waiting, null);
        await keep(run, RUN_KEYS.status, null);
        return { input, ctx: { ...ctx, ...(lineage ? { lineage } : {}) }, resuming: waiting };
      });
    },
    async cancel(runId, opts = {}) {
      if (!isRunId(runId)) return cancelRefused(String(runId), 'error', 'invalid run id');
      let held = holds.get(journal);
      if (!held) holds.set(journal, (held = new Set()));
      if (held.has(runId)) return cancelRefused(runId, 'error', `run ${runId} is in progress`);
      held.add(runId);
      try {
        return await cancelHeld(runId, opts);
      } finally {
        held.delete(runId);
      }
    },
    entries,
    async attribute(result, scores = []) {
      // Over the cap, keep the first hops and the last ones: a run stops at its failing hop, so the tail decides.
      const max = limitNumber(limits.maxRecords);
      const { record } = result;
      const kept = record.length <= max ? record : [...record.slice(0, max - Math.ceil(max / 2)), ...record.slice(record.length - Math.ceil(max / 2))];
      const found = await attribution.attribute({ record: kept, result, scores, source });
      for (const a of found) host.telemetry.metric(METRIC.attributions, 1, { [ATTR.layer]: a.layer, [ATTR.member]: a.member });
      return found;
    },
    async score(evalCase, result) {
      // Without a host scorer the built-in `expected` checks apply: a case is never passed unchecked.
      const read = async (key: string) => execution?.read?.(key);
      return host.score ? host.score.score(evalCase, result, { read }) : expectedScores(evalCase, result, read);
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
        config, host, adapters: used, entries: described, execution: journal,
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
