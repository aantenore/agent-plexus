import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEntry, RunContext } from '@agent-plexus/core';
import { adapter, compilePattern, createSkillRouter, limits, type SkillRouterOptions } from '../src/index.ts';

const entry = (id: string, skills: AgentEntry['skills'] = []): AgentEntry => ({
  id,
  name: id,
  description: '',
  skills,
  endpoint: { protocol: 'function' },
  trust: { signed: false, pinned: true },
});
const skill = (id: string, tags: string[] = []) => ({ id, name: id, description: '', tags });
const run: RunContext = { runId: 'r', system: 's' };

const route = (options: SkillRouterOptions, input: Parameters<ReturnType<typeof createSkillRouter>['route']>[0]['input'], candidates: AgentEntry[]) =>
  createSkillRouter(options, { name: 'router' }).route({ input, candidates }, run);

test('adapter descriptor and limit', () => {
  assert.equal(adapter.fills, 'AgentRouterPort');
  assert.deepEqual(adapter.tiers, ['prototype', 'production']);
  assert.equal(limits.maxInputChars.default, 10_000);
  assert.equal(adapter.limits, limits);
});

test('a matching rule picks its member', async () => {
  const d = await route({ rules: [{ member: 'billing', matches: 'invoice' }] }, 'my invoice is wrong', [entry('triage'), entry('billing')]);
  assert.equal(d.member, 'billing');
  assert.deepEqual(d.ranked, [{ member: 'billing', score: 1 }]);
});

test('(?i) prefix sets the i flag; without it matching is case sensitive', async () => {
  const cs = await route({ rules: [{ member: 'a', matches: 'INVOICE' }] }, 'invoice', [entry('a')]);
  assert.equal(cs.member, undefined);
  const ci = await route({ rules: [{ member: 'a', matches: '(?i)INVOICE' }] }, 'invoice', [entry('a')]);
  assert.equal(ci.member, 'a');
  assert.equal(compilePattern('(?i)x').flags, 'i');
  assert.equal(compilePattern('(?is)x').flags, 'is');
  assert.throws(() => compilePattern('x(?i)'), SyntaxError);
});

test('input as object uses its text', async () => {
  const d = await route({ rules: [{ member: 'a', matches: 'hi' }] }, { text: 'oh hi' }, [entry('a')]);
  assert.equal(d.member, 'a');
});

test('a rule for a member that is not a candidate does not apply', async () => {
  const d = await route({ rules: [{ member: 'billing', matches: '.' }] }, 'x', [entry('triage')]);
  assert.deepEqual(d, {});
});

test('highest weight wins; rule order breaks ties; ranked lists all applicable', async () => {
  const options: SkillRouterOptions = {
    rules: [
      { member: 'a', matches: 'x' },
      { member: 'b', matches: 'x', weight: 5 },
      { member: 'c', matches: 'x' },
      { member: 'a', matches: 'x', weight: 0.5 },
    ],
  };
  const d = await route(options, 'x', [entry('a'), entry('b'), entry('c')]);
  assert.equal(d.member, 'b');
  assert.deepEqual(d.ranked, [{ member: 'b', score: 5 }, { member: 'a', score: 1 }, { member: 'c', score: 1 }]);
  const tie = await route({ rules: [{ member: 'c', matches: 'x' }, { member: 'a', matches: 'x' }] }, 'x', [entry('a'), entry('c')]);
  assert.equal(tie.member, 'c');
});

test('every condition of a rule must hold', async () => {
  const options: SkillRouterOptions = { rules: [{ member: 'a', matches: 'pay', tags: ['money'], skills: ['invoice'] }] };
  const good = entry('a', [skill('invoice', ['money', 'eu'])]);
  assert.equal((await route(options, 'pay', [good])).member, 'a');
  assert.equal((await route(options, 'nope', [good])).member, undefined);
  assert.equal((await route(options, 'pay', [entry('a', [skill('invoice')])])).member, undefined);
  assert.equal((await route(options, 'pay', [entry('a', [skill('other', ['money'])])])).member, undefined);
});

test('tags may be spread over skills; all listed must be present', async () => {
  const options: SkillRouterOptions = { rules: [{ member: 'a', tags: ['x', 'y'] }] };
  assert.equal((await route(options, '', [entry('a', [skill('s1', ['x']), skill('s2', ['y'])])])).member, 'a');
  assert.equal((await route(options, '', [entry('a', [skill('s1', ['x'])])])).member, undefined);
});

test('a rule without conditions applies to its candidate', async () => {
  assert.equal((await route({ rules: [{ member: 'a' }] }, 'anything', [entry('a')])).member, 'a');
});

test('no rule applies gives an empty decision; fallbackRanking lists the candidates without a member', async () => {
  assert.deepEqual(await route({ rules: [] }, 'x', [entry('a')]), {});
  const d = await route({ rules: [{ member: 'a', matches: 'zzz' }], fallbackRanking: true }, 'x', [entry('a'), entry('b')]);
  assert.equal(d.member, undefined);
  assert.deepEqual(d.ranked, [{ member: 'a', score: 0 }, { member: 'b', score: 0 }]);
});

test('prototype-key member ids are plain ids', async () => {
  const d = await route({ rules: [{ member: 'constructor', matches: 'x' }, { member: '__proto__', matches: 'x', weight: 2 }] }, 'x', [entry('constructor'), entry('__proto__')]);
  assert.equal(d.member, '__proto__');
  assert.deepEqual(d.ranked?.map((r) => r.member), ['__proto__', 'constructor']);
  assert.deepEqual(await route({ rules: [{ member: 'a', matches: 'x' }] }, 'x', [entry('toString')]), {});
});

test('regexes see only the first maxInputChars characters', async () => {
  const options: SkillRouterOptions = { rules: [{ member: 'a', matches: 'needle' }], maxInputChars: 10 };
  assert.equal((await route(options, `${'x'.repeat(10)}needle`, [entry('a')])).member, undefined);
  assert.equal((await route(options, 'needle', [entry('a')])).member, 'a');
  const long = `${'a'.repeat(20_000)}needle`;
  assert.equal((await route({ rules: [{ member: 'a', matches: 'needle' }] }, long, [entry('a')])).member, undefined);
});

test('a global-like pattern is stateless between calls', async () => {
  const router = createSkillRouter({ rules: [{ member: 'a', matches: 'x' }] }, { name: 'r' });
  for (let i = 0; i < 3; i++) assert.equal((await router.route({ input: 'x', candidates: [entry('a')] }, run)).member, 'a');
});

test('invalid options fail at create time', () => {
  const make = (options: unknown) => () => createSkillRouter(options as SkillRouterOptions, { name: 'r' });
  assert.throws(make({ rules: [{ member: 'a', matches: '(' }] }), /valid regular expression/);
  assert.throws(make({ rules: [{ member: 'a', matches: '(?i)[' }] }), /valid regular expression/);
  assert.throws(make({}), /rules must be an array/);
  assert.throws(make({ rules: [{ member: '' }] }), /member/);
  assert.throws(make({ rules: [{ member: 'a', weight: Number.NaN }] }), /weight/);
  assert.throws(make({ rules: [{ member: 'a', tags: 'x' }] }), /tags/);
  assert.throws(make({ rules: [{ member: 'a', skills: [1] }] }), /skills/);
  assert.throws(make({ rules: [{ member: 'a', matches: 1 }] }), /matches/);
  assert.throws(make({ rules: [], maxInputChars: 0 }), /maxInputChars/);
  assert.throws(make({ rules: [], maxInputChars: 1.5 }), /maxInputChars/);
});
