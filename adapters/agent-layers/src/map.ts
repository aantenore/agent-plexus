import { ANONYMOUS, isLayer, publicCaller } from '@agent-layers/core';
import type {
  AnonymousCaller, Caller as LayersCaller, EvalCase as LayersEvalCase, EvalRun, EvalScore, GuardStage, Layer, PublicCaller,
  RunResult, StopReason as LayersStopReason,
} from '@agent-layers/core';
import { inputText } from '@agent-plexus/core';
import type { Caller, EvalCase, MemberResult, Score, StopReason, SystemResult } from '@agent-plexus/core';

/** Namespace of the `ext` keys this package writes. */
export const NAMESPACE = 'agent-plexus';
export const ACTORS_KEY = `${NAMESPACE}.actors`;
export const HOPS_KEY = `${NAMESPACE}.hops`;
export const EXPECTED_KEY = `${NAMESPACE}.expected`;

/** Layer reported for a stop that happened in a layer agent-layers does not have (topology, member, host, ...). */
const FALLBACK_LAYER: Layer = 'harness';

const STAGE_OF = { send: 'tool_args', receive: 'tool_result' } as const satisfies Record<'send' | 'receive', GuardStage>;

export const guardStageOf = (stage: 'send' | 'receive'): GuardStage => STAGE_OF[stage];

/** The agent-layers caller of a plexus caller; the credential is carried only when given. */
export function layersCaller(caller: Caller, credential?: string): LayersCaller {
  const ext = { ...caller.ext, ...(caller.actors?.length ? { [ACTORS_KEY]: caller.actors.map((a) => ({ ...a })) } : {}) };
  return {
    id: caller.id,
    kind: caller.kind,
    roles: [...caller.roles],
    scopes: [...caller.scopes],
    ...(caller.name !== undefined ? { name: caller.name } : {}),
    ...(credential !== undefined ? { credential } : {}),
    ...(Object.keys(ext).length ? { ext } : {}),
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
    ...(caller.credential !== undefined ? { credential: caller.credential } : {}),
    ...(caller.ext ? { ext: { ...caller.ext } } : {}),
  };
}

/** An agent-layers run result as a member result, one to one; the guard stage is not carried. */
export function memberResultOf(run: RunResult): MemberResult {
  const { reason } = run;
  return {
    status: run.status,
    output: run.output,
    ...(reason ? {
      reason: {
        code: reason.code,
        ...(reason.layer ? { layer: reason.layer } : {}),
        ...(reason.by ? { by: reason.by } : {}),
        ...(reason.detail ? { detail: reason.detail } : {}),
      },
    } : {}),
    runId: run.runId,
    ...(run.usage ? { usage: { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens } } : {}),
    ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
  };
}

/**
 * A plexus stop reason as an agent-layers one. A layer agent-layers does not have becomes `harness`; the internal
 * `detail` is dropped, as it may carry error text.
 */
export function layersReason(reason: StopReason): LayersStopReason {
  return {
    code: reason.code,
    layer: reason.layer && isLayer(reason.layer) ? reason.layer : FALLBACK_LAYER,
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
