import type { Attribution, HopRecord, Score, SystemResult } from '@agent-plexus/core';

/** `<member> <status> <code?> <ms>ms`; a route that chose nobody has no member. */
export const hopLine = (hop: HopRecord): string =>
  [hop.member || '(route)', hop.status, hop.reason?.code, `${hop.durationMs}ms`].filter(Boolean).join(' ');

/** What a person sees of a result: the output when it completed, else the status and where it stopped. */
export const resultText = (result: SystemResult): string =>
  result.status === 'completed' ? result.output : `[${result.status}] ${[result.reason?.code, result.reason?.layer].filter(Boolean).join(' ')}`.trim();

/** A word the shell passes as it is: quoted unless it is plain. */
const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * How to answer a waiting run: an approval when the host's gate asked, else the input the member asked for, and the
 * wait it answers. A result without a wait falls back on the layer of its reason.
 */
export function resumeHint(result: SystemResult): string {
  const approval = result.wait ? result.wait.kind === 'approval' : result.reason?.layer === 'host';
  const reply = approval ? '--approve | --deny' : '--input <text>';
  return `waiting: agent-plexus resume ${shellWord(result.runId)} ${reply}${result.wait ? ` --wait ${shellWord(result.wait.token)}` : ''}`;
}

/** A reason without its internal detail. */
const withoutDetail = <T extends { detail?: string }>(reason: T): Omit<T, 'detail'> => {
  const { detail: _detail, ...rest } = reason;
  return rest;
};

/** A result safe to print as JSON: the internal detail of its reason and of every hop's reason is left out. */
export function publicResult(result: SystemResult): SystemResult {
  return {
    ...result,
    ...(result.reason ? { reason: withoutDetail(result.reason) } : {}),
    record: result.record.map((hop) => (hop.reason ? { ...hop, reason: withoutDetail(hop.reason) } : hop)),
  };
}

/** `<layer> <member?> <memberLayer?> <confidence> <evidence>` */
export const attributionLine = (a: Attribution): string =>
  [a.layer, a.member, a.memberLayer, a.confidence.toFixed(2), a.evidence.join(',')].filter(Boolean).join(' ');

export const scoreLine = (s: Score): string =>
  [s.metric, s.member, s.value, s.reason].filter((x) => x !== undefined && x !== '').join(' ');
