import { randomUUID } from 'node:crypto';
import type { Attributes, Host } from './hooks.ts';
import { deadlineMs, type Ledger, type Reservation } from './ledger.ts';
import { ATTR, EVENT, METRIC, SPAN } from './names.ts';
import type { CallOptions, CallOutcome, Execution, MemberCallContext, MemberPort } from './ports.ts';
import {
  inputText, RUN_STATUSES, type AgentEntry, type Caller, type HopRecord, type MemberResult, type RunContext, type RunInput,
  type StopReason,
} from './shapes.ts';
import { limitNumber, type SystemLimits } from './system-limits.ts';
import { errorMessage, withoutCredential } from './util.ts';

/** Least time worth starting a member call with. */
const MIN_REMAINING_MS = 1000;
/** Largest delay `setTimeout` accepts. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What stays the same across the runs of a system. */
export interface MemberCallEnv {
  system: string;
  host: Host;
  members: ReadonlyMap<string, MemberPort>;
  /** The member's description, cached by the caller; rejects when the member cannot describe itself. */
  entry(id: string): Promise<AgentEntry>;
  limits: SystemLimits;
  now?: () => number;
}

/** What one run accumulates across its member calls. */
export interface RunState {
  ctx: RunContext;
  rootRunId: string;
  ledger: Ledger;
  execution: Execution;
  steps: number;
  /** Members called, in order (the tail is enough to see back-and-forth). */
  recent: string[];
  records: HopRecord[];
  /** Hops the topology abandoned before their record was written. */
  abandoned: Set<string>;
}

interface Outcome {
  result: MemberResult;
  inputRef?: string;
  outputRef?: string;
}

function stop(code: string, layer?: string, by?: string, detail?: string, status: MemberResult['status'] = 'stopped', stage?: StopReason['stage']): MemberResult {
  const reason: StopReason = { code, ...(layer ? { layer } : {}), ...(by ? { by } : {}), ...(detail ? { detail } : {}), ...(stage ? { stage } : {}) };
  return { status, output: '', reason };
}

/** Length-in-round-trips of the two members alternating at the end of the calls, counting the call about to be made. */
function roundTrips(recent: readonly string[], next: string): number {
  const seq = [...recent, next];
  const n = seq.length;
  const a = seq[n - 1];
  const b = seq[n - 2];
  if (b === undefined || a === b) return 0;
  let len = 2;
  while (len < n && seq[n - 1 - len] === (len % 2 === 0 ? a : b)) len++;
  return Math.floor(len / 2);
}

/** Step 1 without the budget: abort, time left, hops, steps, back-and-forth. */
function checkBounds(env: MemberCallEnv, run: RunState, member: string, options: CallOptions, now: number): MemberResult | undefined {
  const { bounds } = run.ledger;
  if (run.ctx.signal?.aborted || options.signal?.aborted) return stop('aborted');
  if (deadlineMs(bounds) - now < MIN_REMAINING_MS) return stop('timeout', 'topology');
  if (bounds.hops + 1 > bounds.maxHops) return stop('hop_limit', 'topology');
  if (run.steps >= limitNumber(env.limits.maxSteps)) return stop('limit', 'topology', 'limits.system.maxSteps');
  if (roundTrips(run.recent, member) > limitNumber(env.limits.maxRepeats)) return stop('limit', 'topology', 'limits.system.maxRepeats');
  return undefined;
}

/** A verdict that is not one of the three actions is a block. */
type Checked = { text: string } | { blocked: MemberResult };

async function checkText(env: MemberCallEnv, stage: 'send' | 'receive', text: string, entry: AgentEntry, caller: Caller | undefined): Promise<Checked> {
  const blocked = (detail?: string): Checked => ({ blocked: stop('guard_block', 'host', env.host.name, detail, 'stopped', stage) });
  try {
    const verdict = await env.host.gate.check({ stage, text, member: entry, ...(caller ? { caller: withoutCredential(caller) } : {}) });
    if (verdict.action === 'allow') return { text };
    if (verdict.action === 'redact' && typeof verdict.text === 'string') return { text: verdict.text };
    return blocked(verdict.reason);
  } catch (err) {
    return blocked(errorMessage(err));
  }
}

const withText = (input: RunInput, text: string): RunInput => (typeof input === 'string' ? text : { ...input, text });

/** A member's answer as the pipeline relies on it: a known status, a text, and a reason when it did not complete. */
function normalize(value: unknown): MemberResult {
  const r = value as Partial<MemberResult> | null;
  if (!r || typeof r !== 'object' || !RUN_STATUSES.includes(r.status as never) || typeof r.output !== 'string') {
    return stop('error', 'member', undefined, 'invalid member result', 'failed');
  }
  return r.status !== 'completed' && !r.reason ? { ...r, reason: { code: 'error', layer: 'member' } } as MemberResult : r as MemberResult;
}

interface Invocation {
  port: MemberPort;
  input: RunInput;
  ctx: MemberCallContext;
  timeoutMs: number;
  stepBinding: boolean;
  timer: AbortController;
}

/** Calls the member; never rejects. A member that ignores its signal is still cut off at the deadline. */
async function invoke(inv: Invocation): Promise<MemberResult> {
  const { signal } = inv.ctx as { signal: AbortSignal };
  const handle = Number.isFinite(inv.timeoutMs) && inv.timeoutMs <= MAX_TIMER_MS
    ? setTimeout(() => inv.timer.abort(), Math.max(0, inv.timeoutMs))
    : undefined;
  const cutOff = (): MemberResult => inv.timer.signal.aborted
    ? stop('timeout', 'member', inv.stepBinding ? 'limits.system.stepTimeoutMs' : undefined)
    : stop('aborted');
  const aborted = new Promise<'aborted'>((done) => {
    if (signal.aborted) done('aborted');
    else signal.addEventListener('abort', () => done('aborted'), { once: true });
  });
  const call = Promise.resolve().then(() => inv.port.invoke(inv.input, inv.ctx));
  call.catch(() => {});
  try {
    const raced = await Promise.race([call.then((result) => ({ result })), aborted.then(() => undefined)]);
    return raced ? normalize(raced.result) : cutOff();
  } catch (err) {
    return signal.aborted ? cutOff() : stop('error', 'member', undefined, errorMessage(err), 'failed');
  } finally {
    clearTimeout(handle);
  }
}

async function safePut(execution: Execution, text: string): Promise<string | undefined> {
  try {
    return await execution.put(text);
  } catch {
    return undefined;
  }
}

async function pipeline(
  env: MemberCallEnv, run: RunState, hopId: string, member: string, input: RunInput, options: CallOptions, clock: () => number,
): Promise<Outcome> {
  const { host } = env;
  const { ctx, ledger } = run;
  const caller = ctx.caller;

  // 1. System limits and received bounds; reserve budget.
  const refused = checkBounds(env, run, member, options, clock());
  if (refused) {
    if (refused.reason?.code !== 'aborted') host.telemetry.event(EVENT.limit, { [ATTR.layer]: 'topology', [ATTR.member]: member, [ATTR.runReason]: refused.reason!.code });
    return { result: refused };
  }
  const reservation = ledger.reserve(options.share);
  if (!reservation) return { result: stop('limit', 'topology') };
  const index = run.steps++;
  run.recent.push(member);
  run.recent.splice(0, Math.max(0, run.recent.length - (2 * limitNumber(env.limits.maxRepeats) + 2)));
  const early = (result: MemberResult): Outcome => { ledger.release(reservation); return { result }; };

  const port = env.members.get(member);
  let entry: AgentEntry;
  try {
    if (!port) return early(stop('error', 'topology', undefined, `unknown member "${member}"`, 'failed'));
    entry = await env.entry(member);
  } catch (err) {
    return early(stop('error', 'member', undefined, errorMessage(err), 'failed'));
  }

  // 2. May this caller invoke this member.
  try {
    const decision = await host.gate.allow({ ...(caller ? { caller: withoutCredential(caller) } : {}), action: 'invoke', member: entry });
    if (decision.effect === 'ask') return early(stop('needs_input', 'host', host.name, decision.reason, 'waiting'));
    if (decision.effect !== 'allow') return early(stop('denied', 'host', host.name, decision.reason));
  } catch (err) {
    return early(stop('denied', 'host', host.name, errorMessage(err)));
  }

  // 3. Check what is sent.
  const sent = await checkText(env, 'send', inputText(input), entry, caller);
  if ('blocked' in sent) return early(sent.blocked);
  const sentInput = withText(input, sent.text);

  // 4. Credential for the member's audience, on behalf of the caller.
  let credential: string | undefined;
  if (entry.audience) {
    try {
      credential = await host.gate.token(caller, entry.audience);
    } catch (err) {
      return early(stop('needs_auth', 'host', host.name, errorMessage(err)));
    }
    if (credential === undefined && host.tier === 'production') return early(stop('needs_auth', 'host', host.name, 'no credential for the audience'));
  }

  // 5. Call, as a journal step, with outbound bounds and lineage.
  const inputRef = await safePut(run.execution, sent.text);
  const key = `call:${options.node}:${index}`;
  const result = await callAsStep(env, run, hopId, port!, sentInput, credential, reservation, options, key, clock);

  // 6. Check what comes back.
  const spent = { ...(result.usage ? { usage: result.usage } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) };
  let final = result;
  let blocked = false;
  if (result.status === 'completed') {
    const received = await checkText(env, 'receive', result.output, entry, caller);
    blocked = 'blocked' in received;
    final = 'blocked' in received ? { ...received.blocked, ...spent } : { ...result, output: received.text };
  }

  // 7. Settle the reservation; the caller writes the record.
  ledger.settle(reservation, spent);
  const outputRef = blocked ? undefined : await safePut(run.execution, final.output);
  return { result: final, ...(inputRef ? { inputRef } : {}), ...(outputRef ? { outputRef } : {}) };
}

async function callAsStep(
  env: MemberCallEnv, run: RunState, hopId: string, port: MemberPort, input: RunInput, credential: string | undefined,
  reservation: Reservation, options: CallOptions, key: string, clock: () => number,
): Promise<MemberResult> {
  const { ctx, ledger } = run;
  try {
    return await run.execution.step(key, async () => {
      const remaining = deadlineMs(ledger.bounds) - clock();
      const stepMs = limitNumber(env.limits.stepTimeoutMs);
      const timer = new AbortController();
      const signal = AbortSignal.any([timer.signal, ...[ctx.signal, options.signal].filter((s): s is AbortSignal => !!s)]);
      const memberCtx: MemberCallContext = {
        ...ctx,
        ...(ctx.caller ? { caller: withoutCredential(ctx.caller) } : {}),
        lineage: { rootRunId: run.rootRunId, parentRunId: ctx.runId },
        signal,
        hopId,
        ...(credential ? { credential } : {}),
        outbound: ledger.outbound(ctx.runId, run.rootRunId, reservation),
      };
      return invoke({ port, input, ctx: memberCtx, timeoutMs: Math.min(remaining, stepMs), stepBinding: stepMs <= remaining, timer });
    });
  } catch (err) {
    return stop('error', 'execution', undefined, errorMessage(err), 'failed');
  }
}

/**
 * The only way to reach a member: limits and budget, the host's allow and content checks, a credential for the
 * member's audience, the call as a journal step, the check of the answer, and a hop record. Refusals and failures are
 * results, never exceptions, and every call writes a record.
 */
export async function memberCall(env: MemberCallEnv, run: RunState, member: string, input: RunInput, options: CallOptions): Promise<CallOutcome> {
  const hopId = randomUUID();
  const clock = env.now ?? Date.now;
  const startedMs = clock();
  const attrs: Attributes = {
    [ATTR.layer]: 'member', [ATTR.system]: env.system, [ATTR.member]: member, [ATTR.hop]: hopId, [ATTR.nodePath]: options.node,
  };
  const result = await env.host.telemetry.span(SPAN.hop, attrs, async (span) => {
    const outcome = await pipeline(env, run, hopId, member, input, options, clock);
    const { result: r } = outcome;
    run.records.push({
      hopId,
      ...(options.parentHopId ? { parentHopId: options.parentHopId } : {}),
      member,
      node: options.node,
      ...(r.runId ? { runId: r.runId } : {}),
      rootRunId: run.rootRunId,
      hops: run.ledger.bounds.hops + 1,
      startedAt: new Date(startedMs).toISOString(),
      durationMs: Math.max(0, clock() - startedMs),
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.usage ? { usage: r.usage } : {}),
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      ...(options.route ? { route: options.route } : {}),
      ...(outcome.inputRef ? { inputRef: outcome.inputRef } : {}),
      ...(outcome.outputRef ? { outputRef: outcome.outputRef } : {}),
      ...(run.abandoned.has(hopId) ? { abandoned: true } : {}),
    });
    span.set({ [ATTR.runStatus]: r.status, ...(r.reason ? { [ATTR.runReason]: r.reason.code } : {}) });
    env.host.telemetry.metric(METRIC.hops, 1, { [ATTR.layer]: 'member', [ATTR.member]: member, [ATTR.runStatus]: r.status });
    return r;
  });
  return { hopId, result };
}
