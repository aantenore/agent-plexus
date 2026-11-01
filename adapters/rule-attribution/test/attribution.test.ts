import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttributionInput, HopRecord, MemberResult, MemberSpan, RecordSource, Score, StopReason } from '@agent-plexus/core';
import { adapter, CONFIDENCE, createRuleAttribution } from '../src/index.ts';

let counter = 0;
const hop = (member: string, extra: Partial<HopRecord> = {}): HopRecord => {
  counter += 1;
  return {
    hopId: `h${counter}`,
    member,
    node: `root.steps[${counter}]`,
    rootRunId: 'root',
    hops: counter,
    startedAt: '2026-11-01T00:00:00.000Z',
    durationMs: 10,
    status: 'completed',
    ...extra,
  };
};
const stopped = (member: string, reason: StopReason, extra: Partial<HopRecord> = {}) => hop(member, { status: 'stopped', reason, ...extra });
const failed = (member: string, reason: StopReason = { code: 'error' }, extra: Partial<HopRecord> = {}) => hop(member, { status: 'failed', reason, ...extra });

const attributor = createRuleAttribution({}, { name: 'attribution' });
const result: MemberResult = { status: 'failed', output: '' };
const run = (record: HopRecord[], scores: Score[] = [], source?: RecordSource) => {
  const input: AttributionInput = { record, result, scores, ...(source ? { source } : {}) };
  return attributor.attribute(input);
};
const score = (metric: string, value: number, member?: string): Score => ({ metric, value, ...(member ? { member } : {}) });

test('adapter descriptor', () => {
  assert.equal(adapter.fills, 'AttributionPort');
  assert.deepEqual(adapter.tiers, ['prototype', 'production']);
  assert.deepEqual(CONFIDENCE, { high: 0.9, medium: 0.6, low: 0.3 });
});

test('nothing to blame: all completed and no failing score', async () => {
  assert.deepEqual(await run([hop('a'), hop('b')], [score('m', 1)]), []);
  assert.deepEqual(await run([]), []);
});

test('rule 1: the earliest hop that did not complete is the candidate', async () => {
  const a = hop('a');
  const b = failed('b');
  const c = failed('c');
  const [att] = await run([a, b, c]);
  assert.equal(att?.member, 'b');
  assert.equal(att?.hopId, b.hopId);
  assert.equal(att?.layer, 'member');
  assert.equal(att?.by, 'rule-attribution');
});

test('rule 1: abandoned hops are skipped', async () => {
  const lost = failed('slow', { code: 'aborted' } as StopReason, { abandoned: true });
  const bad = failed('b');
  assert.equal((await run([lost, bad]))[0]?.member, 'b');
  assert.deepEqual(await run([lost, hop('ok')]), []);
});

test('rule 1: a per-member expectation that failed marks that member\'s hop', async () => {
  const a = hop('a');
  const b = hop('b');
  const [att] = await run([a, b], [score('contains', 0, 'a'), score('other', 0.5, 'b')]);
  assert.equal(att?.member, 'a');
  assert.equal(att?.hopId, a.hopId);
  assert.equal(att?.layer, 'member');
  assert.equal(att?.confidence, CONFIDENCE.medium);
  // an expectation on a member that passed does not mark it
  assert.deepEqual(await run([a, b], [score('ok', 1, 'a')]), []);
});

test('rule 2: a route node that chose no member is routing, high', async () => {
  const none = stopped('', { code: 'rejected' }, { route: {} });
  const [att] = await run([hop('a'), none]);
  assert.deepEqual([att?.layer, att?.confidence, att?.member, att?.hopId], ['routing', CONFIDENCE.high, undefined, none.hopId]);
  assert.ok(att?.evidence.includes(`node:${none.node}`));
  const withRanking = stopped('', { code: 'rejected' }, { route: { ranked: [{ member: 'x', score: 0 }] } });
  assert.equal((await run([withRanking]))[0]?.layer, 'routing');
});

test('rule 2 does not apply to a route node that chose a member', async () => {
  const bad = failed('a', { code: 'error' }, { route: { member: 'a' } });
  assert.equal((await run([bad]))[0]?.layer, 'member');
});

test('hop_limit: topology, or routing when a router chose the call; no member; high', async () => {
  const [plain] = await run([stopped('a', { code: 'hop_limit' })]);
  assert.deepEqual([plain?.layer, plain?.member, plain?.confidence], ['topology', undefined, CONFIDENCE.high]);
  const [routed] = await run([stopped('a', { code: 'hop_limit' }, { route: { member: 'a' } })]);
  assert.deepEqual([routed?.layer, routed?.member], ['routing', undefined]);
});

test('timeout and limit: topology when the system limit stopped it, else member; the slowest hop; medium', async () => {
  const slow = hop('slow', { durationMs: 900 });
  const fast = hop('fast', { durationMs: 5 });
  const [sys] = await run([slow, fast, stopped('x', { code: 'timeout', layer: 'topology' }, { durationMs: 1 })]);
  assert.deepEqual([sys?.layer, sys?.member, sys?.hopId, sys?.confidence], ['topology', 'slow', slow.hopId, CONFIDENCE.medium]);
  const own = stopped('x', { code: 'limit' }, { durationMs: 700 });
  const [mem] = await run([fast, own]);
  assert.deepEqual([mem?.layer, mem?.member, mem?.confidence], ['member', 'x', CONFIDENCE.medium]);
  const [mem2] = await run([slow, stopped('x', { code: 'timeout', layer: 'agent-loop' }, { durationMs: 1 })]);
  assert.deepEqual([mem2?.layer, mem2?.member], ['member', 'slow']);
});

test('timeout ignores abandoned hops and route nodes when finding the slowest', async () => {
  const lost = hop('lost', { durationMs: 5000, abandoned: true });
  const route = hop('', { durationMs: 4000, route: {} });
  const real = hop('real', { durationMs: 20 });
  const [att] = await run([lost, route, real, stopped('x', { code: 'timeout' }, { durationMs: 1 })]);
  assert.equal(att?.member, 'real');
});

test('host denied and needs_auth refuse the call itself: host, no member, high', async () => {
  for (const code of ['denied', 'needs_auth']) {
    const stop = stopped('b', { code, layer: 'host' });
    const [att] = await run([hop('a'), stop]);
    assert.deepEqual([att?.layer, att?.member, att?.hopId, att?.confidence], ['host', undefined, stop.hopId, CONFIDENCE.high], code);
    assert.ok(att?.evidence.includes(`code:${code}`));
    assert.ok(att?.evidence.includes(`hop:${stop.hopId}`));
  }
});

test('host guard_block on send or without stage names the upstream member, if any', async () => {
  const [first] = await run([stopped('b', { code: 'guard_block', layer: 'host' })]);
  assert.deepEqual([first?.layer, first?.member, first?.confidence], ['host', undefined, CONFIDENCE.high]);
  const up = hop('a');
  for (const stage of [undefined, 'send' as const]) {
    const [att] = await run([up, stopped('b', { code: 'guard_block', layer: 'host', ...(stage ? { stage } : {}) })]);
    assert.deepEqual([att?.layer, att?.member, att?.confidence], ['host', 'a', CONFIDENCE.high], String(stage));
    assert.ok(att?.evidence.includes(`upstream:${up.hopId}`));
  }
});

test('host block on receive names the member whose output was blocked', async () => {
  const blocked = stopped('b', { code: 'guard_block', layer: 'host', stage: 'receive' });
  const [att] = await run([hop('a'), blocked]);
  assert.deepEqual([att?.layer, att?.member, att?.hopId, att?.confidence], ['host', 'b', blocked.hopId, CONFIDENCE.high]);
  assert.ok(att?.evidence.includes('stage:receive'));
});

test('needs_input and needs_auth from a member are not failures', async () => {
  assert.deepEqual(await run([hop('a'), hop('b', { status: 'waiting', reason: { code: 'needs_input' } })]), []);
  assert.deepEqual(await run([hop('a', { status: 'waiting', reason: { code: 'needs_auth', layer: 'agent-identity' } })]), []);
  assert.deepEqual(await run([hop('a', { status: 'waiting' })]), []);
});

test('guard_block inside a member whose input was another member\'s output blames that upstream member, medium', async () => {
  const up = hop('up');
  const mid = hop('', { route: { member: 'down' } });
  const down = stopped('down', { code: 'guard_block', layer: 'guardrail' });
  const [att] = await run([up, mid, down]);
  assert.deepEqual([att?.layer, att?.member, att?.hopId, att?.confidence, att?.memberLayer], ['member', 'up', up.hopId, CONFIDENCE.medium, 'guardrail']);
  assert.ok(att?.evidence.includes(`upstream:${up.hopId}`));
});

test('guard_block with no upstream hop blames the hop: high with a layer, medium without', async () => {
  const [withLayer] = await run([stopped('a', { code: 'guard_block', layer: 'guardrail' })]);
  assert.deepEqual([withLayer?.member, withLayer?.confidence, withLayer?.memberLayer], ['a', CONFIDENCE.high, 'guardrail']);
  const [without] = await run([stopped('a', { code: 'guard_block' })]);
  assert.deepEqual([without?.member, without?.confidence, without?.memberLayer], ['a', CONFIDENCE.medium, undefined]);
});

test('failed and error: the hop; memberLayer from reason.layer; plexus layer ids and host are not member layers', async () => {
  const [withLayer] = await run([failed('a', { code: 'error', layer: 'harness' })]);
  assert.deepEqual([withLayer?.layer, withLayer?.member, withLayer?.memberLayer, withLayer?.confidence], ['member', 'a', 'harness', CONFIDENCE.high]);
  const [plexusId] = await run([failed('a', { code: 'error', layer: 'routing' })]);
  assert.deepEqual([plexusId?.memberLayer, plexusId?.confidence], [undefined, CONFIDENCE.medium]);
  const [noReason] = await run([hop('a', { status: 'failed' })]);
  assert.deepEqual([noReason?.member, noReason?.confidence], ['a', CONFIDENCE.medium]);
});

test('layer topology on a plain error is the topology', async () => {
  const [att] = await run([failed('a', { code: 'error', layer: 'topology' })]);
  assert.equal(att?.layer, 'topology');
});

test('rejected: the hop, low', async () => {
  const [att] = await run([stopped('a', { code: 'rejected' })]);
  assert.deepEqual([att?.layer, att?.member, att?.confidence], ['member', 'a', CONFIDENCE.low]);
});

test('a cancellation is not blamed on an agent', async () => {
  assert.deepEqual(await run([stopped('a', { code: 'aborted' })]), []);
});

test('unknown codes behave like an error of the hop; denied outside the host is the member\'s', async () => {
  const [custom] = await run([stopped('a', { code: 'quota_exceeded' })]);
  assert.deepEqual([custom?.layer, custom?.member], ['member', 'a']);
  const [denied] = await run([stopped('a', { code: 'denied', layer: 'agent-authz' })]);
  assert.deepEqual([denied?.layer, denied?.member, denied?.memberLayer], ['member', 'a', 'agent-authz']);
});

test('rule 4: all hops completed but a score fails: the last completed member, low', async () => {
  const a = hop('a');
  const route = hop('', { route: { member: 'b' } });
  const b = hop('b');
  const [att] = await run([a, b, route], [score('quality', 0.2)]);
  assert.deepEqual([att?.layer, att?.member, att?.hopId, att?.confidence], ['member', 'b', b.hopId, CONFIDENCE.low]);
  assert.ok(att?.evidence.includes('score:quality'));
  assert.deepEqual(await run([], [score('quality', 0)]), []);
});

test('abandoned hops are not the final output producer', async () => {
  const a = hop('a');
  const lost = hop('lost', { abandoned: true });
  assert.equal((await run([a, lost], [score('q', 0)]))[0]?.member, 'a');
});

test('spans: memberLayer comes from the first failed span with a layer', async () => {
  const bad = failed('a', { code: 'error', layer: 'from-reason' });
  const asked: string[] = [];
  const source: RecordSource = {
    name: 'test',
    records: async () => [],
    spans: async (hopId): Promise<MemberSpan[]> => {
      asked.push(hopId);
      return [
        { name: 'ok', layer: 'model', status: 'ok' },
        { name: 'no-layer', status: 'error' },
        { name: 'bad', layer: 'guardrail', status: 'error' },
        { name: 'later', layer: 'tools', status: 'failed' },
      ];
    },
  };
  const [att] = await run([hop('x'), bad], [], source);
  assert.equal(att?.memberLayer, 'guardrail');
  assert.deepEqual(asked, [bad.hopId]);
  const failedStatus: RecordSource = { ...source, spans: async () => [{ name: 's', layer: 'tools', status: 'failed' }] };
  assert.equal((await run([bad], [], failedStatus))[0]?.memberLayer, 'tools');
});

test('spans: no failed span, an error from the source, or no spans function falls back to the reason', async () => {
  const bad = failed('a', { code: 'error', layer: 'from-reason' });
  const quiet: RecordSource = { name: 't', records: async () => [], spans: async () => [{ name: 's', layer: 'model', status: 'ok' }] };
  const broken: RecordSource = { name: 't', records: async () => [], spans: async () => { throw new Error('backend down'); } };
  const plain: RecordSource = { name: 't', records: async () => [] };
  for (const source of [quiet, broken, plain]) assert.equal((await run([bad], [], source))[0]?.memberLayer, 'from-reason');
});

test('spans are read for the blamed hop, not asked for host or topology findings', async () => {
  let asked = 0;
  const source: RecordSource = { name: 't', records: async () => [], spans: async () => { asked++; return []; } };
  await run([stopped('a', { code: 'denied', layer: 'host' })], [], source);
  await run([stopped('a', { code: 'hop_limit' })], [], source);
  assert.equal(asked, 0);
});

test('evidence holds short identifiers, never texts', async () => {
  const bad = failed('a', { code: 'error', detail: 'secret internal text', by: 'instance-1' }, { inputRef: 'r:t1', outputRef: 'r:t2' });
  const [att] = await run([bad]);
  const joined = att?.evidence.join('|') ?? '';
  assert.ok(!joined.includes('secret'));
  assert.ok(!joined.includes('instance-1'));
  assert.ok(att?.evidence.every((e) => e.length < 80));
});

test('prototype-key member ids are plain ids', async () => {
  const [att] = await run([failed('constructor'), failed('__proto__')], [score('x', 0, 'toString')]);
  assert.equal(att?.member, 'constructor');
  const [byScore] = await run([hop('hasOwnProperty'), hop('b')], [score('x', 0, 'hasOwnProperty')]);
  assert.equal(byScore?.member, 'hasOwnProperty');
});

test('the input record is not changed', async () => {
  const record = [hop('a'), failed('b')];
  const before = JSON.stringify(record);
  await run(record, [score('x', 0)]);
  assert.equal(JSON.stringify(record), before);
});
