import type { Attribution, HopRecord, Score, SystemResult } from '@agent-plexus/core';

/** `<member> <status> <code?> <ms>ms`; a route that chose nobody has no member. */
export const hopLine = (hop: HopRecord): string =>
  [hop.member || '(route)', hop.status, hop.reason?.code, `${hop.durationMs}ms`].filter(Boolean).join(' ');

/** What a person sees of a result: the output when it completed, else the status and where it stopped. */
export const resultText = (result: SystemResult): string =>
  result.status === 'completed' ? result.output : `[${result.status}] ${[result.reason?.code, result.reason?.layer].filter(Boolean).join(' ')}`.trim();

/** A result safe to print as JSON: the reason's internal detail is left out. */
export function publicResult(result: SystemResult): SystemResult {
  if (!result.reason || result.reason.detail === undefined) return result;
  const { detail: _detail, ...reason } = result.reason;
  return { ...result, reason };
}

/** `<layer> <member?> <memberLayer?> <confidence> <evidence>` */
export const attributionLine = (a: Attribution): string =>
  [a.layer, a.member, a.memberLayer, a.confidence.toFixed(2), a.evidence.join(',')].filter(Boolean).join(' ');

export const scoreLine = (s: Score): string =>
  [s.metric, s.member, s.value, s.reason].filter((x) => x !== undefined && x !== '').join(' ');
