import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConditionFns, matchesCondition } from '../src/condition.ts';
import type { MemberResult } from '../src/shapes.ts';

const ok: MemberResult = { status: 'completed', output: 'order 42 shipped', ext: { 'x.score': 3 } };
const stopped: MemberResult = { status: 'stopped', output: '', reason: { code: 'timeout' } };

test('every field set must hold', () => {
  assert.equal(matchesCondition({ status: 'completed' }, ok, {}), true);
  assert.equal(matchesCondition({ status: ['stopped', 'failed'] }, ok, {}), false);
  assert.equal(matchesCondition({ code: 'timeout' }, stopped, {}), true);
  assert.equal(matchesCondition({ code: ['limit', 'timeout'], status: 'stopped' }, stopped, {}), true);
  assert.equal(matchesCondition({ code: 'timeout' }, ok, {}), false);
  assert.equal(matchesCondition({ matches: 'order \\d+' }, ok, {}), true);
  assert.equal(matchesCondition({ matches: '(' }, ok, {}), false);
  assert.equal(matchesCondition({ ext: { 'x.score': 3 } }, ok, {}), true);
  assert.equal(matchesCondition({ ext: { 'x.score': 4 } }, ok, {}), false);
  assert.equal(matchesCondition({ status: 'completed', matches: 'nope' }, ok, {}), false);
  assert.equal(matchesCondition({}, ok, {}), true);
});

test('fn conditions use the loaded functions and fail loudly when missing', () => {
  assert.equal(matchesCondition({ fn: 'm#yes' }, ok, { 'm#yes': () => true }), true);
  assert.equal(matchesCondition({ fn: 'm#no' }, ok, { 'm#no': () => false }), false);
  assert.throws(() => matchesCondition({ fn: 'm#gone' }, ok, {}), /not loaded/);
});

test('loadConditionFns imports every fn of the topology, relative to cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-'));
  await writeFile(join(dir, 'conds.mjs'), 'export const done = (r) => r.output === "done"; export const notFn = 1;');
  const fns = await loadConditionFns({
    kind: 'sequence',
    steps: ['a', { kind: 'loop', body: 'a', until: { fn: './conds.mjs#done' } }, { kind: 'graph', nodes: { s: 'a' }, start: 's', edges: [{ from: 's', to: 's', when: { fn: './conds.mjs#done' } }], end: ['s'] }],
  }, dir);
  assert.deepEqual(Object.keys(fns), ['./conds.mjs#done']);
  assert.equal(fns['./conds.mjs#done']!({ status: 'completed', output: 'done' }), true);
  await assert.rejects(loadConditionFns({ kind: 'loop', body: 'a', until: { fn: './conds.mjs#notFn' } }, dir), /notFn is not an exported function/);
  await assert.rejects(loadConditionFns({ kind: 'loop', body: 'a', until: { fn: './missing.mjs#x' } }, dir), /cannot load/);
});
