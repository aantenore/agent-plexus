import { randomUUID } from 'node:crypto';
import type { Attributes, GateAnswer, Host, SpanHandle } from './hooks.ts';
import { deadlineMs, type DeadlineBy, type Ledger, type Reservation } from './ledger.ts';
import { ATTR, EVENT, METRIC, SPAN } from './names.ts';
import type { CallOptions, CallOutcome, Execution, MemberCallContext, MemberPort } from './ports.ts';
import {
  inputText, isRunInput, RUN_STATUSES, type AgentEntry, type Caller, type HopRecord, type MemberResult, type ResumeReply,
  type RunContext, type RunInput, type StopReason, type WaitRef,
} from './shapes.ts';
import { limitNumber, type SystemLimits } from './system-limits.ts';
import { errorMessage, isPlainObject, withoutCredential } from './util.ts';

/** Largest delay `setTimeout` accepts. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Longest task handle a member may checkpoint. */
const MAX_TASK_REF = 1024;

/** What stays the same across the runs of a system. */
export interface MemberCallEnv {
  system: string;
  host: Host;
  members: ReadonlyMap<string, MemberPort>;
  /** The member's description, cached by the caller; rejects when the member cannot describe itself. */
  entry(id: string): Promise<AgentEntry>;
  limits: SystemLimits;
  now?: () => number;
  /** With `registry.requireListed`: whether the registry returns the member; one it does not is `denied` before the gate. */
  listed?(id: string): Promise<boolean>;
}

/** What one run accumulates across its member calls. */
export interface RunState {
  ctx: RunContext;
  rootRunId: string;
  ledger: Ledger;
  execution: Execution;
  steps: number;
  /** Calls made so far per node path: the `<n>` of the next call's step key. */
  calls?: Map<string, number>;
  /** Members called, in order (the tail is enough to see back-and-forth). */
  recent: string[];
  records: HopRecord[];
  /** Calls that ended waiting, in order; the one the run's result names is kept as `run:waiting` when the run ends waiting. */
  waits?: WaitingCall[];
  /** The wait a `System.resume` answers: its call reads the reply with `Execution.wait`. */
  resuming?: WaitingCall;
}

/** A call a run waits on, kept under `run:waiting` so `System.resume` can answer it. */
export interface WaitingCall {
  /** Step key of the call's first attempt: `call:<node path>:<n>`, the n-th call (from 0) with that node path in the run. */
  key: string;
  /** The attempt that waits: 0 for the first call, n after the n-th resume. */
  attempt: number;
  /** `gate`: the host's gate answered `ask`; `member`: the member waits for input. */
  kind: 'gate' | 'member';
  member: string;
  node: string;
}

/**
 * Keys the core keeps for a run with `Execution.remember`. `owner` is the identity of the caller that started the run
 * (null without one); `claimed` is the wait whose reply a resume delivered, so a run begun again after a crash reads it.
 */
export const RUN_KEYS = {
  input: 'run:input', lineage: 'run:lineage', owner: 'run:owner', waiting: 'run:waiting', status: 'run:status', claimed: 'run:claimed',
} as const;

/** The step key `<prefix>:<node path>:<n>` of the next step of a node path, n counting that path's steps in the run. */
export function nextStepKey(counts: Map<string, number>, prefix: string, node: string): string {
  const n = counts.get(node) ?? 0;
  counts.set(node, n + 1);
  return `${prefix}:${node}:${n}`;
}

/** Name of the signal that answers attempt `attempt` of the call `key`. */
export const replyName = (key: string, attempt: number): string => `${key}:reply:${attempt}`;

/** The token of a wait: `<step key>#<attempt>`. */
export const waitToken = (wait: Pick<WaitingCall, 'key' | 'attempt'>): string => `${wait.key}#${wait.attempt}`;

/** A wait as a result names it: its token, what answers it, and the member. */
export const waitRef = (wait: WaitingCall): WaitRef =>
  ({ token: waitToken(wait), kind: wait.kind === 'gate' ? 'approval' : 'input', member: wait.member });

/** Longest wait token a reply may name. */
const MAX_WAIT_TOKEN = 2048;

/** The wait a reply names: undefined when it names none, false when `wait` is not a token. */
export function replyWait(value: unknown): string | undefined | false {
  if (!isPlainObject(value) || value.wait === undefined) return undefined;
  return typeof value.wait === 'string' && value.wait.length > 0 && value.wait.length <= MAX_WAIT_TOKEN ? value.wait : false;
}

/** A reply as `System.resume` accepts it: exactly one of `input` and `approved` (its `wait` is read by `replyWait`). */
export function resumeReply(value: unknown): ResumeReply | undefined {
  if (!isPlainObject(value)) return undefined;
  const hasInput = Object.hasOwn(value, 'input');
  if (hasInput === Object.hasOwn(value, 'approved')) return undefined;
  if (hasInput) return isRunInput(value.input) ? { input: value.input } : undefined;
  if (typeof value.approved !== 'boolean' || (value.reason !== undefined && typeof value.reason !== 'string')) return undefined;
  return { approved: value.approved, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
}

/** A kept `run:waiting` value, or undefined when the run waits on nothing. */
export function waitingCall(value: unknown): WaitingCall | undefined {
  if (!isPlainObject(value)) return undefined;
  const { key, attempt, kind, member, node } = value;
  if (typeof key !== 'string' || typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) return undefined;
  if ((kind !== 'gate' && kind !== 'member') || typeof member !== 'string' || typeof node !== 'string') return undefined;
  return { key, attempt, kind, member, node };
}

interface Outcome {
  result: MemberResult;
  /** The call's journal step replayed: its usage and cost were spent by an earlier invocation. */
  replayed?: boolean;
  inputRef?: string;
  outputRef?: string;
  /** Step key of the call's first attempt and the attempt made, once known. */
  key?: string;
  attempt?: number;
  /** Who made the call wait, when it ended waiting. */
  wait?: WaitingCall['kind'];
}

/** What an attempt of a call carries, kept under `<key>:attempt` from the first resume on. */
interface Attempt {
  n: number;
  /** The answer to the gate's `ask`, passed to `gate.allow`; `by` is the id of the caller that resumed. */
  answer?: GateAnswer;
  /** The input a waiting member asked for: sent through `resume` instead of invoking the member again. */
  input?: RunInput;
}

/** An approval as kept or signalled: `approved`, `reason` and the resuming caller's id under `by`. */
function gateAnswer(value: unknown): GateAnswer | undefined {
  if (!isPlainObject(value)) return undefined;
  const reply = resumeReply({ approved: value.approved, ...(value.reason !== undefined ? { reason: value.reason } : {}) });
  if (!reply || !('approved' in reply)) return undefined;
  return { ...reply, ...(typeof value.by === 'string' ? { by: value.by } : {}) };
}

function attemptOf(value: unknown): Attempt {
  if (!isPlainObject(value) || typeof value.n !== 'number' || !Number.isInteger(value.n) || value.n < 1) return { n: 0 };
  const answer = gateAnswer(value.answer);
  return {
    n: value.n,
    ...(answer ? { answer } : {}),
    ...(isRunInput(value.input) ? { input: value.input } : {}),
  };
}

const stepName = (key: string, attempt: number): string => (attempt ? `${key}#${attempt}` : key);

/**
 * The attempt this call makes. When the run resumes this call's wait, the reply is read with `Execution.wait` (its
 * signal came first, so the deadline is now) and the next attempt is kept before anything else happens.
 */
async function nextAttempt(run: RunState, key: string, now: number): Promise<Attempt> {
  const kept = attemptOf(await run.execution.recall(`${key}:attempt`));
  const waiting = run.resuming;
  if (waiting?.key !== key || waiting.attempt !== kept.n) return kept;
  const signalled = await run.execution.wait(replyName(key, kept.n), new Date(now).toISOString());
  const answer = gateAnswer(signalled);
  const reply = answer ?? resumeReply(signalled);
  if (!reply) return kept;
  const next: Attempt = 'input' in reply
    ? { n: kept.n + 1, input: reply.input }
    : { n: kept.n + 1, answer: reply, ...(kept.input !== undefined ? { input: kept.input } : {}) };
  await run.execution.remember(`${key}:attempt`, next);
  return next;
}

/** The task handle kept by the latest earlier attempt of the call. */
async function keptHandle(execution: Execution, key: string, before: number): Promise<string | undefined> {
  for (let n = before - 1; n >= 0; n--) {
    const ref = await execution.recall(`${stepName(key, n)}:task`);
    if (typeof ref === 'string') return ref;
  }
  return undefined;
}

/**
 * Keeps the handle a waiting member returned without checkpointing it, so a resume can continue its task. A write that
 * fails is reported; without the handle a resume stops with `rejected`.
 */
async function keepHandle(env: MemberCallEnv, execution: Execution, stepKey: string, taskRef: unknown): Promise<void> {
  if (typeof taskRef !== 'string' || taskRef.length === 0 || taskRef.length > MAX_TASK_REF) return;
  const key = `${stepKey}:task`;
  try {
    if ((await execution.recall(key)) === undefined) await execution.remember(key, taskRef);
  } catch (err) {
    env.host.telemetry.event(EVENT.writeFailed, { [ATTR.layer]: 'execution', [ATTR.system]: env.system, [ATTR.executionKey]: key, [ATTR.errorMessage]: errorMessage(err) });
  }
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
  if (deadlineMs(bounds) - now < limitNumber(env.limits.minRemainingMs)) return stop('timeout', 'topology');
  if (bounds.hops + 1 > bounds.maxHops) return stop('hop_limit', 'topology');
  if (run.steps >= limitNumber(env.limits.maxSteps)) return stop('limit', 'topology', 'limits.system.maxSteps');
  if (roundTrips(run.recent, member) > limitNumber(env.limits.maxRepeats)) return stop('limit', 'topology', 'limits.system.maxRepeats');
  return undefined;
}

/** A verdict that is not one of the three actions is a block. */
type Checked = { text: string } | { blocked: MemberResult };

async function checkText(env: MemberCallEnv, stage: 'send' | 'receive', text: string, entry: AgentEntry, run: RunState): Promise<Checked> {
  const { caller, runId, sessionId } = run.ctx;
  const blocked = (detail?: string): Checked => ({ blocked: stop('guard_block', 'host', env.host.name, detail, 'stopped', stage) });
  try {
    const verdict = await env.host.gate.check({ stage, text, member: entry, runId, ...(sessionId ? { sessionId } : {}), ...(caller ? { caller: withoutCredential(caller) } : {}) });
    if (verdict.action === 'allow') return { text };
    if (verdict.action === 'redact' && typeof verdict.text === 'string') return { text: verdict.text };
    return blocked(verdict.reason);
  } catch (err) {
    return blocked(errorMessage(err));
  }
}

/** The checked text only: `parts` never reach a member, as the gate's check sees text alone. */
const withText = (input: RunInput, text: string): RunInput => (typeof input === 'string' ? text : { text });

const partCount = (input: RunInput): number => (typeof input === 'string' || !Array.isArray(input.parts) ? 0 : input.parts.length);

/**
 * A member's answer as the pipeline relies on it: a known status, a text, and a reason when it did not complete. A
 * `wait` is the core's to set, so the member's own is dropped.
 */
function normalize(value: unknown): MemberResult {
  const r = value as Partial<MemberResult> | null;
  if (!r || typeof r !== 'object' || !RUN_STATUSES.includes(r.status as never) || typeof r.output !== 'string') {
    return stop('error', 'member', undefined, 'invalid member result', 'failed');
  }
  const { wait: _wait, ...own } = r;
  return (own.status !== 'completed' && !own.reason ? { ...own, reason: { code: 'error', layer: 'member' } } : own) as MemberResult;
}

interface Invocation {
  port: MemberPort;
  input: RunInput;
  ctx: MemberCallContext;
  timeoutMs: number;
  /** True when the step timeout, not the run deadline, is the shorter. */
  stepBinding: boolean;
  /** Who set the run deadline. */
  deadlineBy: DeadlineBy;
  timer: AbortController;
  /** Handle of remote work; the member continues it instead of being called again. */
  taskRef?: string;
  /** Send `input` with the handle: the reply a waiting member asked for. */
  send?: boolean;
}

/**
 * What a member call came to. `final` when the member returned it (whatever its status); not when the call threw, timed
 * out or was aborted, which a later attempt may not repeat.
 */
interface Invoked {
  result: MemberResult;
  final: boolean;
}

/** Calls the member (or continues its remote work); never rejects. A member that ignores its signal is still cut off at the deadline. */
async function invoke(inv: Invocation): Promise<Invoked> {
  const { signal } = inv.ctx as { signal: AbortSignal };
  const handle = Number.isFinite(inv.timeoutMs) && inv.timeoutMs <= MAX_TIMER_MS
    ? setTimeout(() => inv.timer.abort(), Math.max(0, inv.timeoutMs))
    : undefined;
  const cutOff = (): MemberResult => inv.timer.signal.aborted
    ? (inv.stepBinding ? stop('timeout', 'member', 'limits.system.stepTimeoutMs') : stop('timeout', 'topology', inv.deadlineBy))
    : stop('aborted');
  const aborted = new Promise<'aborted'>((done) => {
    if (signal.aborted) done('aborted');
    else signal.addEventListener('abort', () => done('aborted'), { once: true });
  });
  const { taskRef } = inv;
  const call = Promise.resolve().then(() => (taskRef !== undefined ? inv.port.resume!(taskRef, inv.send ? inv.input : undefined, inv.ctx) : inv.port.invoke(inv.input, inv.ctx)));
  call.catch(() => {});
  try {
    const raced = await Promise.race([call.then((result) => ({ result })), aborted.then(() => undefined)]);
    return raced ? { result: normalize(raced.result), final: true } : { result: cutOff(), final: false };
  } catch (err) {
    return { result: signal.aborted ? cutOff() : stop('error', 'member', undefined, errorMessage(err), 'failed'), final: false };
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
  env: MemberCallEnv, run: RunState, hopId: string, member: string, input: RunInput, options: CallOptions, clock: () => number, span: SpanHandle,
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
  run.steps++;
  // Keyed by node path, not by the order calls happen in: parallel branches replay to the same keys whatever finishes first.
  const key = nextStepKey(run.calls ??= new Map(), 'call', options.node);
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

  // With registry.requireListed the registry decides which members exist, also for a member the topology names.
  if (env.listed) {
    let listed = false;
    let detail = `member ${member} is not in the registry`;
    try {
      listed = await env.listed(member);
    } catch (err) {
      detail = errorMessage(err);
    }
    if (!listed) return early(stop('denied', 'registry', undefined, detail));
  }

  // The attempt: a call the run resumes reads its reply first.
  let attempt: Attempt;
  try {
    attempt = await nextAttempt(run, key, clock());
  } catch (err) {
    return early(stop('error', 'execution', undefined, errorMessage(err), 'failed'));
  }
  const done = (result: MemberResult, wait?: WaitingCall['kind']): Outcome => ({ ...early(result), key, attempt: attempt.n, ...(wait ? { wait } : {}) });

  // 2. May this caller invoke this member.
  try {
    const decision = await host.gate.allow({
      runId: ctx.runId, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), ...(caller ? { caller: withoutCredential(caller) } : {}), action: 'invoke', member: entry,
      ...(attempt.answer ? { answer: attempt.answer } : {}),
    });
    if (decision.effect === 'ask') return done(stop('needs_input', 'host', host.name, decision.reason, 'waiting'), 'gate');
    if (decision.effect !== 'allow') return done(stop('denied', 'host', host.name, decision.reason));
  } catch (err) {
    return done(stop('denied', 'host', host.name, errorMessage(err)));
  }

  // A reply for a waiting member continues its remote task: it needs `resume` and a kept handle.
  let handle: string | undefined;
  if (attempt.input !== undefined) {
    try {
      handle = port!.resume ? await keptHandle(run.execution, key, attempt.n) : undefined;
    } catch (err) {
      return done(stop('error', 'execution', undefined, errorMessage(err), 'failed'));
    }
    if (handle === undefined) return done(stop('rejected', 'member', undefined, `member ${member} cannot resume`));
  }

  // 3. Check what is sent: the reply, when there is one.
  const outgoing = attempt.input ?? input;
  const sent = await checkText(env, 'send', inputText(outgoing), entry, run);
  if ('blocked' in sent) return done(sent.blocked);
  const sentInput = withText(outgoing, sent.text);
  const dropped = partCount(outgoing);
  if (dropped > 0) span.event(EVENT.partsDropped, { [ATTR.partsCount]: dropped });

  // 4. Credential for the member's audience, on behalf of the caller.
  let credential: string | undefined;
  if (entry.audience) {
    try {
      credential = await host.gate.token(caller, entry.audience);
    } catch (err) {
      return done(stop('needs_auth', 'host', host.name, errorMessage(err)));
    }
    if (credential === undefined && host.tier === 'production') return done(stop('needs_auth', 'host', host.name, 'no credential for the audience'));
  }

  // 5. Call, as a journal step, with outbound bounds and lineage. Each attempt is a step of its own.
  const inputRef = await safePut(run.execution, sent.text);
  const stepKey = stepName(key, attempt.n);
  const { result, replayed } = await callAsStep(env, run, hopId, port!, sentInput, credential, reservation, options, stepKey, clock, span, handle);
  if (result.status === 'waiting') await keepHandle(env, run.execution, stepKey, result.taskRef);

  // 6. Check what comes back.
  const spent = { ...(result.usage ? { usage: result.usage } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) };
  let final = result;
  let blocked = false;
  if (result.status === 'completed') {
    const received = await checkText(env, 'receive', result.output, entry, run);
    blocked = 'blocked' in received;
    final = 'blocked' in received ? { ...received.blocked, ...spent } : { ...result, output: received.text };
  }

  // 7. Settle the reservation (a replayed step spends nothing in this run); the caller writes the record.
  if (replayed) ledger.release(reservation);
  else ledger.settle(reservation, spent);
  const outputRef = blocked ? undefined : await safePut(run.execution, final.output);
  return {
    result: final, key, attempt: attempt.n, ...(final.status === 'waiting' ? { wait: 'member' as const } : {}),
    ...(replayed ? { replayed } : {}), ...(inputRef ? { inputRef } : {}), ...(outputRef ? { outputRef } : {}),
  };
}

/** Carries a call's outcome that is not final out of `Execution.step`, so the step stores nothing and a later attempt calls again. */
class NotFinal extends Error {
  readonly result: MemberResult;
  constructor(result: MemberResult) {
    super('not final');
    this.result = result;
  }
}

async function callAsStep(
  env: MemberCallEnv, run: RunState, hopId: string, port: MemberPort, input: RunInput, credential: string | undefined,
  reservation: Reservation, options: CallOptions, key: string, clock: () => number, span: SpanHandle, handle?: string,
): Promise<{ result: MemberResult; replayed: boolean }> {
  const { ctx, ledger, execution } = run;
  const taskKey = `${key}:task`;
  let ran = false;
  try {
    const result = await execution.step(key, async () => {
      ran = true;
      // A task handle journaled by an attempt that did not finish the step: continue that work, do not send again.
      const prior = await execution.recall(taskKey);
      const kept = typeof prior === 'string' && port.resume ? prior : undefined;
      // Otherwise the handle of an earlier attempt, to send the reply a waiting member asked for.
      const taskRef = kept ?? handle;
      if (taskRef !== undefined) span.event(EVENT.memberResumed);
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
        outbound: ledger.outbound(ctx.runId, run.rootRunId, reservation, limitNumber(env.limits.marginMs), stepMs),
        checkpoint: async (ref) => {
          if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_TASK_REF) {
            span.event(EVENT.checkpointIgnored);
            return;
          }
          await execution.remember(taskKey, ref);
        },
      };
      const invoked = await invoke({
        port, input, ctx: memberCtx, timeoutMs: Math.min(remaining, stepMs), stepBinding: stepMs <= remaining, deadlineBy: ledger.deadlineBy, timer,
        ...(taskRef !== undefined ? { taskRef, send: kept === undefined } : {}),
      });
      // Only what the member returned is journaled; a throw, a timeout or an abort is retried by a later attempt.
      if (!invoked.final) throw new NotFinal(invoked.result);
      return invoked.result;
    });
    return { result, replayed: !ran };
  } catch (err) {
    if (err instanceof NotFinal) return { result: err.result, replayed: false };
    return { result: stop('error', 'execution', undefined, errorMessage(err), 'failed'), replayed: false };
  }
}

/**
 * The only way to reach a member: limits and budget, the registry when it must list members, the host's allow and content
 * checks, a credential for the member's audience, the call as a journal step, the check of the answer, and a hop record. Refusals and failures are
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
    const outcome = await pipeline(env, run, hopId, member, input, options, clock, span);
    let { result: r } = outcome;
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
      ...(outcome.attempt ? { attempt: outcome.attempt } : {}),
      ...(outcome.replayed ? { replayed: true } : {}),
    });
    // A waiting result names its wait, so the run keeps the wait its own result reports.
    if (outcome.wait && r.status === 'waiting' && outcome.key !== undefined) {
      const wait: WaitingCall = { key: outcome.key, attempt: outcome.attempt ?? 0, kind: outcome.wait, member, node: options.node };
      (run.waits ??= []).push(wait);
      r = { ...r, wait: waitRef(wait) };
    }
    span.set({ [ATTR.runStatus]: r.status, ...(r.reason ? { [ATTR.runReason]: r.reason.code } : {}) });
    env.host.telemetry.metric(METRIC.hops, 1, { [ATTR.layer]: 'member', [ATTR.member]: member, [ATTR.runStatus]: r.status });
    if (!outcome.replayed) return r;
    // The record keeps what the call spent; the topology's totals count only what this invocation spends.
    const { usage: _usage, costUsd: _costUsd, ...unspent } = r;
    return unspent;
  });
  return { hopId, result };
}
