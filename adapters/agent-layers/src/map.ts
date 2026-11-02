import { ANONYMOUS, isLayer, publicCaller } from '@agent-layers/core';
import type {
  Actor, AnonymousCaller, Bounds as LayersBounds, Caller as LayersCaller, Delegation, EvalCase as LayersEvalCase, EvalRun, EvalScore,
  GuardStage, Layer, PublicCaller, RunResult, StopReason as LayersStopReason,
} from '@agent-layers/core';
import { inputText, memberLayerOf } from '@agent-plexus/core';
import type { Bounds, Caller, EvalCase, Ext, MemberResult, OutboundBounds, Score, StopCode, StopReason, SystemResult } from '@agent-plexus/core';

/** Namespace of the `ext` keys this package writes. */
export const NAMESPACE = 'agent-plexus';
export const HOPS_KEY = `${NAMESPACE}.hops`;
export const EXPECTED_KEY = `${NAMESPACE}.expected`;
/** `ext` key of a member result waiting for an approval of the stack: `{ id, by?, tool? }` from `ext["sdk.approval"]`. */
export const APPROVAL_KEY = 'agent-layers.approval';
/** `ext` key under which agent-layers reports the approval a waiting run waits for. */
const SDK_APPROVAL = 'sdk.approval';
/** Latest instant a Date can hold: the deadline of a run that has none. */
const NO_DEADLINE = new Date(8.64e15).toISOString();

/** Layer reported for a stop that happened in a layer agent-layers does not have (topology, member, host, ...). */
const FALLBACK_LAYER: Layer = 'harness';

const STAGE_OF = { send: 'tool_args', receive: 'tool_result' } as const satisfies Record<'send' | 'receive', GuardStage>;

export const guardStageOf = (stage: 'send' | 'receive'): GuardStage => STAGE_OF[stage];

/** One entry of an actor chain: the same fields on both sides, `issuer` included. */
const actorOf = (a: Actor): Actor => ({
  id: a.id,
  kind: a.kind,
  ...(a.name !== undefined ? { name: a.name } : {}),
  ...(a.issuer !== undefined ? { issuer: a.issuer } : {}),
});

/** The agent-layers caller of a plexus caller, actors included; the credential is carried only when given. */
export function layersCaller(caller: Caller, credential?: string): LayersCaller {
  return {
    id: caller.id,
    kind: caller.kind,
    roles: [...caller.roles],
    scopes: [...caller.scopes],
    ...(caller.name !== undefined ? { name: caller.name } : {}),
    ...(caller.actors?.length ? { actors: caller.actors.map(actorOf) } : {}),
    ...(credential !== undefined ? { credential } : {}),
    ...(caller.ext && Object.keys(caller.ext).length ? { ext: { ...caller.ext } } : {}),
  };
}

/** What an access question carries: the caller without credential, or the explicit anonymous caller. */
export function questionCaller(caller: Caller | undefined): PublicCaller | AnonymousCaller {
  const mapped = caller ? publicCaller(layersCaller(caller)) : undefined;
  return mapped ?? { ...ANONYMOUS, roles: [], scopes: [] };
}

/** The plexus caller of an agent-layers caller; the credential stays in memory. */
export function plexusCaller(caller: LayersCaller): Caller {
  return {
    id: caller.id,
    kind: caller.kind,
    roles: [...caller.roles],
    scopes: [...caller.scopes],
    ...(caller.name !== undefined ? { name: caller.name } : {}),
    ...(caller.actors?.length ? { actors: caller.actors.map(actorOf) } : {}),
    ...(caller.credential !== undefined ? { credential: caller.credential } : {}),
    ...(caller.ext ? { ext: { ...caller.ext } } : {}),
  };
}

/** What a member call passes on to the stack's run: the outbound bounds, which can only tighten the stack's limits. */
export function delegationOf(outbound: OutboundBounds): Delegation {
  return {
    remainingMs: outbound.remainingMs,
    hops: outbound.hops,
    maxHops: outbound.maxHops,
    ...(outbound.tokens !== undefined ? { tokens: outbound.tokens } : {}),
    ...(outbound.costUsd !== undefined ? { costUsd: outbound.costUsd } : {}),
    rootRunId: outbound.rootRunId,
    parentRunId: outbound.parentRunId,
  };
}

/**
 * The bounds a system run starts with, from the bounds of the agent-layers run it serves: the same deadline (none: the
 * latest date) and hops, and as budget what the run reserved for it.
 */
export function plexusBounds(bounds: LayersBounds, reserved: { tokens?: number; costUsd?: number } = {}): Bounds {
  return {
    deadlineAt: bounds.deadlineAt ?? NO_DEADLINE,
    hops: bounds.hops,
    maxHops: bounds.maxHops,
    ...(reserved.tokens !== undefined ? { tokens: reserved.tokens } : {}),
    ...(reserved.costUsd !== undefined ? { costUsd: reserved.costUsd } : {}),
  };
}

/** `{ id, by?, tool? }` of `ext["sdk.approval"]` on a waiting run; undefined when absent or malformed. */
function approvalOf(run: RunResult): Ext | undefined {
  const value = run.status === 'waiting' ? run.ext?.[SDK_APPROVAL] : undefined;
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') return undefined;
  const { id, by, tool } = value as { id: string; by?: unknown; tool?: unknown };
  return { [APPROVAL_KEY]: { id, ...(typeof by === 'string' ? { by } : {}), ...(typeof tool === 'string' ? { tool } : {}) } };
}

/**
 * An agent-layers run result as a member result, one to one: the stop is the `member` layer's, and the agent-layers layer
 * that stopped it is `memberLayer`. The guard stage is not carried. A run waiting for an approval keeps the approval
 * under `ext["agent-layers.approval"]`.
 */
export function memberResultOf(run: RunResult): MemberResult {
  const { reason } = run;
  const approval = approvalOf(run);
  return {
    status: run.status,
    output: run.output,
    ...(reason ? {
      reason: {
        code: reason.code,
        layer: 'member',
        ...(reason.layer ? { memberLayer: reason.layer } : {}),
        ...(reason.by ? { by: reason.by } : {}),
        ...(reason.detail ? { detail: reason.detail } : {}),
      },
    } : {}),
    runId: run.runId,
    ...(run.usage ? { usage: { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens } } : {}),
    ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
    ...(approval ? { ext: approval } : {}),
  };
}

/**
 * A refusal of agent-layers run control (`RunRefused.kind`) as a member result: `[status, code, agent-layers layer]`.
 * A `conflict` leaves the run as it was (its approval still pending, a resume in progress elsewhere, or cancelled until
 * it expires), so the call keeps waiting on it.
 */
const REFUSAL: Readonly<Record<string, readonly [MemberResult['status'], StopCode, Layer]>> = {
  not_found: ['stopped', 'rejected', 'harness'],
  invalid: ['stopped', 'rejected', 'harness'],
  forbidden: ['stopped', 'denied', 'identity'],
  conflict: ['waiting', 'needs_input', 'harness'],
};

/** The kind of an agent-layers `RunRefused`, read by its shape (older agent-layers versions have no such class). */
export function refusalKind(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.name !== 'RunRefused') return undefined;
  const { kind } = err as Error & { kind?: unknown };
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * A run-control refusal of the stack run `runId` as a member result, in the `member` layer with the agent-layers layer
 * as `memberLayer`; the kind leads the internal `detail`. A waiting result keeps `runId` as its `taskRef`. An unknown
 * kind is a failure.
 */
export function refusedResult(kind: string, message: string, runId: string): MemberResult {
  const mapped = REFUSAL[kind];
  const detail = `${kind}: ${message}`;
  if (!mapped) return { status: 'failed', output: '', reason: { code: 'error', layer: 'member', detail }, runId };
  const [status, code, memberLayer] = mapped;
  return { status, output: '', reason: { code, layer: 'member', memberLayer, detail }, runId, ...(status === 'waiting' ? { taskRef: runId } : {}) };
}

/**
 * A plexus stop reason as an agent-layers one. The layer is the member's own layer when agent-layers has it (a stack
 * member's stop), else `reason.layer` when agent-layers has it, else `harness`; the internal `detail` is dropped, as it
 * may carry error text.
 */
export function layersReason(reason: StopReason): LayersStopReason {
  const own = memberLayerOf(reason);
  return {
    code: reason.code,
    layer: own && isLayer(own) ? own : reason.layer && isLayer(reason.layer) ? reason.layer : FALLBACK_LAYER,
    ...(reason.by ? { by: reason.by } : {}),
    ...(reason.stage ? { stage: guardStageOf(reason.stage) } : {}),
  };
}

/** A system result as an agent-layers run result. Hop records are reported as a count; their texts never cross. */
export function runResultOf(result: SystemResult, runId: string): RunResult {
  return {
    runId,
    status: result.status,
    output: result.output,
    ...(result.reason ? { reason: layersReason(result.reason) } : {}),
    ...(result.usage ? { usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ext: { [HOPS_KEY]: result.record.length },
  };
}

/**
 * An eval case for agent-layers evaluators. `expected` is the expected output text (`equals`, else `contains`, else
 * `matches`; the evaluator decides how to compare); the whole plexus expectation is under `ext`.
 */
export function layersEvalCase(evalCase: EvalCase): LayersEvalCase {
  const output = evalCase.expected?.output;
  const text = output?.equals ?? output?.contains ?? output?.matches;
  return {
    id: evalCase.id,
    input: inputText(evalCase.input),
    ...(text !== undefined ? { expected: text } : {}),
    ...(evalCase.tags ? { tags: [...evalCase.tags] } : {}),
    ...(evalCase.expected ? { ext: { [EXPECTED_KEY]: evalCase.expected } } : {}),
  };
}

export function evalRunOf(result: SystemResult): EvalRun {
  return {
    runId: result.runId,
    output: result.output,
    status: result.status,
    ...(result.reason ? { reason: layersReason(result.reason) } : {}),
  };
}

export const plexusScore = (score: EvalScore): Score => ({
  metric: score.metric,
  value: score.value,
  ...(score.reason ? { reason: score.reason } : {}),
});
