import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prototypeHost } from '../src/prototype-host.ts';
import type { EvalCase, HopRecord, SystemResult } from '../src/shapes.ts';

const hop = (member: string, extra: Partial<HopRecord> = {}): HopRecord => ({
  hopId: member, member, node: 'root', rootRunId: 'r', hops: 1, startedAt: new Date().toISOString(), durationMs: 1, status: 'completed', ...extra,
});
const result = (output: string, record: HopRecord[] = []): SystemResult => ({ status: 'completed', output, runId: 'r', record });

test('the gate allows everything, gives no token and checks nothing', async () => {
  const h = prototypeHost({ quiet: true });
  assert.equal(h.tier, 'prototype');
  assert.equal((await h.gate.allow({ runId: 'r', action: 'invoke', member: {} as never })).effect, 'allow');
  assert.equal(await h.gate.token(undefined, 'aud'), undefined);
  assert.equal((await h.gate.check({ runId: 'r', stage: 'send', text: 'x', member: {} as never })).action, 'allow');
});

test('one line per hop span end; other spans and quiet mode write nothing', async () => {
  const lines: string[] = [];
  const h = prototypeHost({ write: (l) => lines.push(l) });
  await h.telemetry.span('plexus.run', { 'plexus.layer': 'topology' }, async () => {});
  await h.telemetry.span('plexus.hop', { 'plexus.layer': 'member', 'plexus.member': 'triage' }, async (s) => { s.set({ 'plexus.run.status': 'stopped', 'plexus.run.reason': 'denied' }); });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^plexus\.hop member=triage status=stopped code=denied ms=\d+$/);
  const quiet: string[] = [];
  await prototypeHost({ quiet: true, write: (l) => quiet.push(l) }).telemetry.span('plexus.hop', {}, async () => {});
  assert.deepEqual(quiet, []);
});

test('score: expected output equals, contains, matches', async () => {
  const h = prototypeHost({ quiet: true });
  const c = (output: EvalCase['expected'] & object): EvalCase => ({ id: 'c', input: 'q', expected: output });
  assert.deepEqual((await h.score!.score(c({ output: { equals: 'yes' } }), result('yes')))[0], { metric: 'expected.output', value: 1 });
  assert.equal((await h.score!.score(c({ output: { equals: 'yes' } }), result('no')))[0]!.value, 0);
  assert.equal((await h.score!.score(c({ output: { contains: 'es', matches: '^y' } }), result('yes')))[0]!.value, 1);
  assert.equal((await h.score!.score(c({ output: { contains: 'es', matches: '^n' } }), result('yes')))[0]!.value, 0);
  assert.deepEqual(await h.score!.score({ id: 'c', input: 'q' }, result('yes')), []);
});

test('score: member expectations check the status and, with a reader, the output', async () => {
  const texts: Record<string, string> = { k1: 'invoice paid' };
  const h = prototypeHost({ quiet: true, read: async (k) => texts[k] });
  const record = [hop('billing', { outputRef: 'k1' }), hop('triage', { status: 'failed' })];
  const scores = await h.score!.score({
    id: 'c', input: 'q',
    expected: { members: { billing: { contains: 'paid', status: 'completed' }, triage: { status: 'completed' }, ghost: { status: 'completed' } } },
  }, result('x', record));
  assert.deepEqual(scores.map((s) => [s.metric, s.member, s.value]), [['expected.member', 'billing', 1], ['expected.member', 'triage', 0], ['expected.member', 'ghost', 0]]);
  const noReader = await prototypeHost({ quiet: true }).score!.score({ id: 'c', input: 'q', expected: { members: { billing: { contains: 'paid' } } } }, result('x', record));
  assert.equal(noReader[0]!.value, 0);
});
