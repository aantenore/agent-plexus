import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger, openBounds } from '../src/ledger.ts';
import { resolveLimits } from '../src/system-limits.ts';
import type { Bounds, RunContext } from '../src/shapes.ts';

const limits = resolveLimits({ system: { timeoutMs: 10_000, maxDepth: 2 } });
const ctx = (bounds?: Bounds): RunContext => ({ runId: 'r', system: 's', ...(bounds ? { bounds } : {}) });
const NOW = Date.parse('2026-01-01T00:00:00Z');

test('openBounds without host bounds uses the system limits', () => {
  const b = openBounds(ctx(), limits, NOW);
  assert.equal(Date.parse(b.deadlineAt), NOW + 10_000);
  assert.equal(b.hops, 0);
  assert.equal(b.maxHops, 2);
  assert.equal(b.tokens, undefined);
});

test('openBounds only tightens: the earlier deadline wins, host hops and budget stand', () => {
  const sooner = new Date(NOW + 2_000).toISOString();
  const later = new Date(NOW + 60_000).toISOString();
  assert.equal(openBounds(ctx({ deadlineAt: sooner, hops: 1, maxHops: 5, tokens: 50, costUsd: 1 }), limits, NOW).deadlineAt, sooner);
  const b = openBounds(ctx({ deadlineAt: later, hops: 1, maxHops: 5, tokens: 50, costUsd: 1 }), limits, NOW);
  assert.equal(Date.parse(b.deadlineAt), NOW + 10_000);
  assert.deepEqual([b.hops, b.maxHops, b.tokens, b.costUsd], [1, 5, 50, 1]);
});

test('maxDepth adds to the host hops when the host gave no maxHops; unbounded limits still give a deadline', () => {
  const b = openBounds({ runId: 'r', system: 's', bounds: { deadlineAt: new Date(NOW + 9e6).toISOString(), hops: 2, maxHops: undefined as never } }, limits, NOW);
  assert.equal(b.maxHops, 4);
  const open = openBounds(ctx(), resolveLimits({ system: { timeoutMs: 'unbounded', maxDepth: 'unbounded' } }), NOW);
  assert.ok(Date.parse(open.deadlineAt) > NOW + 1e12);
  assert.ok(open.maxHops > 1e6);
});

test('an unreadable host deadline counts as passed', () => {
  assert.ok(Date.parse(openBounds(ctx({ deadlineAt: 'soon', hops: 0, maxHops: 1 }), limits, NOW).deadlineAt) <= NOW);
});

const bounds = (extra: Partial<Bounds> = {}): Bounds => ({ deadlineAt: new Date(NOW + 60_000).toISOString(), hops: 1, maxHops: 4, ...extra });

test('reservations never exceed what is left', () => {
  const l = new Ledger(bounds({ tokens: 100, costUsd: 1 }), () => NOW);
  const a = l.reserve(0.5)!;
  assert.deepEqual(a, { tokens: 50, costUsd: 0.5 });
  const b = l.reserve()!;
  assert.deepEqual(b, { tokens: 50, costUsd: 0.5 });
  assert.equal(l.reserve(), undefined);
  assert.deepEqual(l.remaining(), { tokens: 0, costUsd: 0 });
});

test('settle debits what was spent and releases the rest', () => {
  const l = new Ledger(bounds({ tokens: 100, costUsd: 1 }), () => NOW);
  const r = l.reserve()!;
  l.settle(r, { usage: { inputTokens: 10, outputTokens: 20 }, costUsd: 0.25 });
  assert.deepEqual(l.remaining(), { tokens: 70, costUsd: 0.75 });
  l.settle(r, { usage: { inputTokens: 70, outputTokens: 0 } });
  assert.deepEqual(l.remaining(), { tokens: 70, costUsd: 0.75 });
});

test('nothing reported counts as fully spent, per dimension', () => {
  const l = new Ledger(bounds({ tokens: 100, costUsd: 1 }), () => NOW);
  l.settle(l.reserve(0.5)!);
  assert.deepEqual(l.remaining(), { tokens: 50, costUsd: 0.5 });
  l.settle(l.reserve(0.5)!, { usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal(l.remaining().tokens, 48);
  assert.equal(l.remaining().costUsd, 0.25);
  l.settle(l.reserve()!, { usage: { inputTokens: -5, outputTokens: 1 } });
  assert.equal(l.remaining().tokens, 0);
});

test('release gives a reservation back untouched', () => {
  const l = new Ledger(bounds({ tokens: 10 }), () => NOW);
  l.release(l.reserve()!);
  assert.deepEqual(l.remaining(), { tokens: 10 });
});

test('without a budget reservations are empty and never run out', () => {
  const l = new Ledger(bounds(), () => NOW);
  assert.deepEqual(l.reserve(), {});
  assert.deepEqual(l.remaining(), {});
});

test('outbound carries one more hop, the reserved budget and the time left minus the margin', () => {
  let now = NOW;
  const l = new Ledger(bounds({ tokens: 100 }), () => now);
  const r = l.reserve(0.5)!;
  const first = l.outbound('run', 'root', r, 1000);
  assert.deepEqual([first.hops, first.maxHops, first.tokens, first.rootRunId, first.parentRunId], [2, 4, 50, 'root', 'run']);
  assert.equal(first.remainingMs, 59_000);
  now += 10_000;
  assert.equal(l.outbound('run', 'root', r, 1000).remainingMs, 49_000);
  assert.equal(l.outbound('run', 'root', r, 0).remainingMs, 50_000);
  now += 100_000;
  assert.equal(l.outbound('run', 'root', r, 1000).remainingMs, 0);
});
