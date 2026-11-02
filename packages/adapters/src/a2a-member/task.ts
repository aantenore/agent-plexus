import type { Message, Part, Task } from '@a2a-js/sdk';
import { taskStateToJSON, TaskState } from '@a2a-js/sdk';
import type { MemberResult, StopReason, Usage } from '@agent-plexus/core';
import { BOUNDS_ALIAS_URI, BOUNDS_URI } from './bounds.ts';

/** States a task does not leave on its own. */
const TERMINAL: readonly TaskState[] = [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED];
/** States where the remote agent waits for the caller. */
const INTERRUPTED: readonly TaskState[] = [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED];
/** States where the remote agent is still working. */
const ACTIVE: readonly TaskState[] = [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING];

/** Key of the task metadata entry where an agent-layers stack reports usage and cost. */
const FIGURES_KEY = 'agent-layers';
/** Where a task reports its run, first found first: the bounds extension report (either URI), then `agent-layers`. */
const REPORT_KEYS: readonly string[] = [BOUNDS_URI, BOUNDS_ALIAS_URI, FIGURES_KEY];
/** Stop codes the bounds extension report carries: the receiver's own bounds stopped the run. */
const BOUNDS_STOPS: readonly string[] = ['timeout', 'limit', 'hop_limit'];
/** Key of `ext` that keeps the native task state when it is not one this adapter maps. */
export const STATE_EXT = 'a2a-member.state';

export const isActive = (task: Task): boolean => task.status !== undefined && ACTIVE.includes(task.status.state);

/** The text parts of a list of parts, and data parts as JSON, one per line. */
export function partsText(parts: Part[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      const content = p?.content;
      if (content?.$case === 'text') return content.value;
      if (content?.$case === 'data' && content.value !== undefined) return JSON.stringify(content.value);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export const messageText = (m: Message | undefined): string => partsText(m?.parts);

/** A send answers with a task or with a direct message reply; only a message has a `messageId`. */
export const isTask = (value: Task | Message): value is Task => !('messageId' in value);

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

const usageOf = (m: Record<string, unknown>): Usage | undefined => {
  const u = m.usage && typeof m.usage === 'object' ? (m.usage as Record<string, unknown>) : undefined;
  return u && count(u.inputTokens) && count(u.outputTokens) ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens } : undefined;
};

/**
 * Usage, cost and a bounds stop a task reports. Each figure is read from the bounds extension report
 * (`metadata[<uri>]`, either URI) first, else from `metadata["agent-layers"]`; malformed values are ignored. Only the
 * report carries a stop.
 */
export function reportedFigures(metadata: Task['metadata']): { usage?: Usage; costUsd?: number; stop?: string } {
  const all = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const bags = REPORT_KEYS.map((k) => [k, all[k]] as const).filter((e): e is readonly [string, Record<string, unknown>] => !!e[1] && typeof e[1] === 'object');
  const usage = bags.map(([, m]) => usageOf(m)).find((u) => u !== undefined);
  const costUsd = bags.map(([, m]) => m.costUsd).find(count);
  const stop = bags.filter(([k]) => k !== FIGURES_KEY).map(([, m]) => m.stop).find((v): v is string => typeof v === 'string' && BOUNDS_STOPS.includes(v));
  return { ...(usage ? { usage } : {}), ...(costUsd !== undefined ? { costUsd } : {}), ...(stop ? { stop } : {}) };
}

/** Whether the task needs no more polling: it ended, or it waits for the caller. */
export function settled(task: Task): boolean {
  const state = task.status?.state;
  return state !== undefined && (TERMINAL.includes(state) || INTERRUPTED.includes(state));
}

/**
 * A settled task as a member result. `reason.layer` is absent: the layer of the remote stop is unknown. A failed,
 * stopped or unknown task keeps the remote wording out of the output; one the remote run's own bounds stopped (the
 * report's `stop`) is `stopped` with that code (`timeout`, `limit`, `hop_limit`).
 */
export function taskResult(task: Task, name: string, taskRef: string): MemberResult {
  const state = task.status?.state;
  const { stop, ...figures } = reportedFigures(task.metadata);
  const answer = task.artifacts.map((a) => partsText(a.parts)).filter(Boolean).join('\n');
  const statusText = messageText(task.status?.message);
  const base = { ...figures };
  const stopped = (code: StopReason['code']): MemberResult => ({ status: 'stopped', output: '', reason: { code: stop ?? code, by: name }, ...base });
  switch (state) {
    case TaskState.TASK_STATE_COMPLETED:
      return { status: 'completed', output: answer || statusText, ...base };
    case TaskState.TASK_STATE_CANCELED:
      return stopped('aborted');
    case TaskState.TASK_STATE_REJECTED:
      return stopped('rejected');
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return { status: 'waiting', output: statusText, reason: { code: 'needs_input', by: name }, taskRef, ...base };
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return { status: 'waiting', output: statusText, reason: { code: 'needs_auth', by: name }, taskRef, ...base };
    case TaskState.TASK_STATE_FAILED:
      return stop ? stopped('error') : { status: 'failed', output: '', reason: { code: 'error', by: name }, ...base };
    default:
      return { status: 'failed', output: '', reason: { code: 'error', by: name }, ext: { [STATE_EXT]: state === undefined ? 'missing' : taskStateToJSON(state) }, ...base };
  }
}

/** The reference of a task: an opaque string that holds its id and its context. */
export function encodeRef(taskId: string, contextId: string): string {
  return `a2a1.${Buffer.from(JSON.stringify([taskId, contextId])).toString('base64url')}`;
}

export function decodeRef(ref: string): { taskId: string; contextId: string } | undefined {
  if (!ref.startsWith('a2a1.')) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(ref.slice(5), 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' && parsed[0]) return { taskId: parsed[0], contextId: parsed[1] };
  } catch {
    // falls through to undefined
  }
  return undefined;
}
