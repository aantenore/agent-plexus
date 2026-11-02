import { isDeepStrictEqual } from 'node:util';
import type { Attribution, AttributionInput, AttributionLayer, AttributionPort, HopRecord, MemberResult, RecordSource } from '@agent-plexus/core';
import { Checks } from '../check.ts';
import { attributionProblems } from '../shapes.ts';

/** Text the suite puts in the journal: it must never be copied into an attribution. */
export const CANARY_TEXT = 'conformance-canary-text-b81e2d never copy this into evidence';

export interface AttributionCase {
  input: AttributionInput;
  /** What the adapter must name: an empty list for nothing; each item matches one attribution by the fields it sets. */
  expect: Partial<Pick<Attribution, 'layer' | 'member' | 'hopId' | 'memberLayer'>>[];
}

export interface AttributionFixtures {
  /** The adapter's rules table: inputs and what each must give. */
  cases?: AttributionCase[];
}

let seq = 0;
/** A hop record with defaults; ids are unique per suite run. */
export function hop(over: Partial<HopRecord> = {}): HopRecord {
  return {
    hopId: `h${++seq}`,
    member: 'billing',
    node: 'root.steps[0]',
    rootRunId: 'conformance-run',
    hops: 1,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    durationMs: 5,
    status: 'completed',
    ...over,
  };
}

const done = (output = 'ok'): MemberResult => ({ status: 'completed', output });
const stopped = (code: string, layer = 'member'): MemberResult => ({ status: 'stopped', output: '', reason: { code, layer } });
const waiting = (code: string): MemberResult => ({ status: 'waiting', output: '', reason: { code, layer: 'member' } });

function canarySource(record: HopRecord[], failing = false): RecordSource {
  const boom = async (): Promise<never> => { throw new Error('source unavailable'); };
  return failing
    ? { name: 'conformance', records: boom, spans: boom, text: boom }
    : { name: 'conformance', records: async () => record, spans: async () => [], text: async () => CANARY_TEXT };
}

/** Runs the AttributionPort rules At1-At8 against an instance. */
export async function checkAttribution(port: AttributionPort, f: AttributionFixtures = {}, c = new Checks()): Promise<Checks> {
  if (!c.expect('At1', typeof port?.attribute === 'function', 'attribute must be a function')) return c;
  const attribute = async (rule: string, label: string, input: AttributionInput): Promise<Attribution[] | undefined> => {
    const out = await c.attempt(rule, label, () => port.attribute(input));
    if (out === undefined) return undefined;
    if (!c.expect('At2', Array.isArray(out), `${label}: attribute must resolve to a list`)) return undefined;
    out.forEach((a, i) => c.all('At2', attributionProblems(a, input.record), `${label}: attribution[${i}]`));
    c.expect('At5', !JSON.stringify(out).includes(CANARY_TEXT.slice(0, 24)), `${label}: an attribution must never carry a stored text`);
    return out;
  };

  // At1: no record and a completed run: nothing to attribute.
  const empty = await attribute('At1', 'empty record', { record: [], result: done(), scores: [] });
  c.expect('At1', empty?.length === 0, 'an empty record of a completed run must give no attribution');
  await attribute('At1', 'empty record of a failed run', { record: [], result: { status: 'failed', output: '', reason: { code: 'error', layer: 'topology' } }, scores: [] });

  // At2: the shape of attributions over failing records (checked in `attribute` for every call).
  const failing = [
    hop({ member: 'triage', node: 'root.steps[0]' }),
    hop({ member: 'billing', node: 'root.steps[1]', status: 'failed', reason: { code: 'error', layer: 'member', memberLayer: 'model' } }),
  ];
  await attribute('At2', 'failed member', { record: failing, result: { status: 'failed', output: '', reason: { code: 'error', layer: 'member' } }, scores: [] });
  const denied = [hop({ status: 'stopped', reason: { code: 'denied', layer: 'host' } })];
  await attribute('At2', 'gate denied', { record: denied, result: stopped('denied', 'host'), scores: [] });
  const lowScore = [hop({ member: 'billing' })];
  await attribute('At2', 'low score', { record: lowScore, result: done(), scores: [{ metric: 'expected.member', value: 0, member: 'billing' }] });

  // At3: hops the topology abandoned are skipped.
  const abandoned = hop({ member: 'slow', node: 'root.branches[1]', status: 'stopped', reason: { code: 'error', layer: 'member' }, abandoned: true });
  const winner = hop({ member: 'fast', node: 'root.branches[0]' });
  for (const result of [done('fast'), { status: 'failed', output: '', reason: { code: 'error', layer: 'member' } } as MemberResult]) {
    const out = await attribute('At3', `abandoned hop, run ${result.status}`, { record: [winner, abandoned], result, scores: [] });
    c.expect('At3', !out?.some((a) => a.hopId === abandoned.hopId || a.member === 'slow'), `an abandoned hop must never be attributed (run ${result.status})`);
  }

  // At4: waiting and aborted are not failures.
  for (const [code, result, status] of [
    ['needs_input', waiting('needs_input'), 'waiting'],
    ['needs_auth', waiting('needs_auth'), 'waiting'],
    ['aborted', stopped('aborted'), 'stopped'],
  ] as const) {
    const record = [hop({ member: 'triage' }), hop({ member: 'billing', status, reason: { code, layer: 'member' } })];
    const out = await attribute('At4', `${code}`, { record, result, scores: [] });
    c.expect('At4', out?.length === 0, `a run that stopped with ${code} is not a failure: it must give no attribution, got ${JSON.stringify(out)}`);
  }

  // At5: stored texts never reach the evidence, whatever the source gives.
  const texts = [
    hop({ member: 'triage', inputRef: 'run:t1', outputRef: 'run:t2' }),
    hop({ member: 'billing', node: 'root.steps[1]', inputRef: 'run:t2', outputRef: 'run:t3' }),
  ];
  await attribute('At5', 'stored texts', { record: texts, result: done(CANARY_TEXT), scores: [{ metric: 'expected.output', value: 0, reason: 'failed: contains' }], source: canarySource(texts) });
  const failedTexts = texts.map((h, i) => (i === 1 ? { ...h, status: 'failed' as const, reason: { code: 'error', layer: 'member', detail: CANARY_TEXT } } : h));
  await attribute('At5', 'stored texts, failed run', { record: failedTexts, result: { status: 'failed', output: '', reason: { code: 'error', layer: 'member', detail: CANARY_TEXT } }, scores: [], source: canarySource(failedTexts) });

  // At6: only reason.code drives: `detail` and `by` change nothing.
  for (const code of ['error', 'timeout', 'guard_block', 'limit']) {
    const at = (detail: string, by: string) => [hop({ hopId: `code-${code}-0`, member: 'triage' }), hop({ hopId: `code-${code}-1`, member: 'billing', node: 'root.steps[1]', status: code === 'limit' ? 'stopped' : 'failed', reason: { code, layer: code === 'guard_block' ? 'host' : 'member', detail, by } })];
    const result = (detail: string): MemberResult => ({ status: code === 'limit' ? 'stopped' : 'failed', output: '', reason: { code, layer: 'member', detail } });
    const a = await attribute('At6', `code ${code}, one detail`, { record: at('denied needs_input aborted routing', 'x'), result: result('needs_input aborted'), scores: [] });
    const b = await attribute('At6', `code ${code}, another detail`, { record: at('', 'y'), result: result(''), scores: [] });
    c.expect('At6', isDeepStrictEqual(a, b), `code ${code}: detail and by must not change the attribution`);
  }

  // At7: a source that fails is tolerated; no source is fine.
  const record = [hop({ member: 'triage' }), hop({ member: 'billing', node: 'root.steps[1]', status: 'failed', reason: { code: 'error', layer: 'member' }, inputRef: 'run:t1', outputRef: 'run:t2' })];
  const result: MemberResult = { status: 'failed', output: '', reason: { code: 'error', layer: 'member' } };
  const plain = await attribute('At7', 'no source', { record, result, scores: [] });
  const broken = await attribute('At7', 'a source that fails', { record, result, scores: [], source: canarySource(record, true) });
  c.expect('At7', plain !== undefined && broken !== undefined && broken.length === plain.length, 'a source that fails must be ignored, not fail the attribution');

  // At8: the adapter's rules table.
  if (!f.cases?.length) c.skip('At8', 'rules table: needs the cases fixture');
  for (const [i, item] of (f.cases ?? []).entries()) {
    const out = await attribute('At8', `case[${i}]`, item.input);
    if (!out) continue;
    if (!item.expect.length) c.expect('At8', out.length === 0, `case[${i}]: expected no attribution, got ${JSON.stringify(out)}`);
    for (const want of item.expect) {
      const found = out.some((a) => Object.entries(want).every(([k, v]) => (a as unknown as Record<string, unknown>)[k] === v));
      c.expect('At8', found, `case[${i}]: no attribution matches ${JSON.stringify(want)} in ${JSON.stringify(out.map((a) => ({ layer: a.layer, member: a.member })))}`);
    }
  }
  return c;
}

export type { AttributionLayer };
