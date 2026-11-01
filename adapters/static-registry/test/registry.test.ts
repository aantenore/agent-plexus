import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEntry } from '@agent-plexus/core';
import { adapter, createStaticRegistry, type StaticRegistryOptions } from '../src/index.ts';

const entry = (id: string, extra: Partial<AgentEntry> = {}): AgentEntry => ({
  id,
  name: id,
  description: `${id} member`,
  skills: [],
  endpoint: { protocol: 'function' },
  trust: { signed: false, pinned: true },
  ...extra,
});

const base = () => [
  entry('triage', { skills: [{ id: 'intake', name: 'intake', description: '', tags: ['general'] }] }),
  entry('billing', { attrs: { region: 'eu', tier: 1 } }),
  entry('constructor'),
];

const registry = (options: StaticRegistryOptions, members: () => Promise<AgentEntry[]> = async () => base()) =>
  createStaticRegistry(options, { name: 'registry', members });

test('adapter descriptor', () => {
  assert.equal(adapter.fills, 'RegistryPort');
  assert.deepEqual(adapter.tiers, ['prototype', 'production']);
});

test('list returns the members unchanged without overrides; get finds by id', async () => {
  const r = registry({});
  assert.deepEqual((await r.list()).map((e) => e.id), ['triage', 'billing', 'constructor']);
  assert.equal((await r.get('billing'))?.id, 'billing');
  assert.equal(await r.get('missing'), undefined);
  assert.equal(await r.get('toString'), undefined);
});

test('members are read at call time', async () => {
  let members = [entry('a')];
  const r = registry({}, async () => members);
  assert.equal((await r.list()).length, 1);
  members = [entry('a'), entry('b')];
  assert.equal((await r.list()).length, 2);
});

test('overrides change description, add tags as a skill and merge attrs without mutating the source', async () => {
  const source = base();
  const r = registry({ entries: { billing: { description: 'Invoices', tags: ['money'], attrs: { tier: 2, team: 'fin' } } } }, async () => source);
  const billing = await r.get('billing');
  assert.equal(billing?.description, 'Invoices');
  assert.deepEqual(billing?.skills.map((s) => [s.id, s.tags]), [['tags', ['money']]]);
  assert.deepEqual(billing?.attrs, { region: 'eu', tier: 2, team: 'fin' });
  assert.equal(source[1]?.description, 'billing member');
  assert.deepEqual(source[1]?.skills, []);
  assert.deepEqual(source[1]?.attrs, { region: 'eu', tier: 1 });
});

test('skills override replaces the member skills; tags are added after them', async () => {
  const r = registry({ entries: { triage: { skills: [{ id: 'sort', tags: ['x'] }], tags: ['y'] } } });
  const triage = await r.get('triage');
  assert.deepEqual(triage?.skills.map((s) => s.id), ['sort', 'tags']);
  assert.deepEqual(triage?.skills[0], { id: 'sort', name: 'sort', description: '', tags: ['x'] });
});

test('overrides for unknown ids are ignored; prototype-key ids work', async () => {
  const r = registry({ entries: { ghost: { description: 'x' }, constructor: { description: 'ctor' } } });
  assert.equal((await r.list()).length, 3);
  assert.equal((await r.get('constructor'))?.description, 'ctor');
  assert.equal((await r.get('triage'))?.description, 'triage member');
});

test('filter by skills: any skill id matches', async () => {
  const r = registry({ entries: { billing: { skills: [{ id: 'invoice' }, { id: 'refund' }] } } });
  assert.deepEqual((await r.list({ skills: ['refund', 'nothing'] })).map((e) => e.id), ['billing']);
  assert.deepEqual((await r.list({ skills: ['nothing'] })).map((e) => e.id), []);
  assert.equal((await r.list({ skills: [] })).length, 3);
});

test('filter by tags: all tags must be present across skills', async () => {
  const r = registry({ entries: { billing: { skills: [{ id: 'a', tags: ['x'] }, { id: 'b', tags: ['y'] }] } } });
  assert.deepEqual((await r.list({ tags: ['x', 'y'] })).map((e) => e.id), ['billing']);
  assert.deepEqual((await r.list({ tags: ['x', 'z'] })).map((e) => e.id), []);
  assert.deepEqual((await r.list({ tags: ['general'] })).map((e) => e.id), ['triage']);
});

test('filter by attrs: equality, list means any of, missing never matches', async () => {
  const r = registry({});
  assert.deepEqual((await r.list({ attrs: { region: 'eu' } })).map((e) => e.id), ['billing']);
  assert.deepEqual((await r.list({ attrs: { region: ['us', 'eu'] } })).map((e) => e.id), ['billing']);
  assert.deepEqual((await r.list({ attrs: { region: ['us'] } })).map((e) => e.id), []);
  assert.deepEqual((await r.list({ attrs: { tier: '1' } })).map((e) => e.id), []);
  assert.deepEqual((await r.list({ attrs: { region: 'eu', tier: 1 } })).map((e) => e.id), ['billing']);
  assert.deepEqual((await r.list({ attrs: { constructor: 'x' } })).map((e) => e.id), []);
});

test('a list-valued attr on the entry matches a scalar filter', async () => {
  const r = registry({ entries: { triage: { attrs: { langs: ['en', 'it'] } } } });
  assert.deepEqual((await r.list({ attrs: { langs: 'it' } })).map((e) => e.id), ['triage']);
});

test('filters combine', async () => {
  const r = registry({ entries: { billing: { skills: [{ id: 'invoice', tags: ['money'] }] } } });
  assert.deepEqual((await r.list({ skills: ['invoice'], tags: ['money'], attrs: { region: 'eu' } })).map((e) => e.id), ['billing']);
  assert.deepEqual((await r.list({ skills: ['invoice'], attrs: { region: 'us' } })).map((e) => e.id), []);
});

test('invalid options fail at create time', () => {
  const ctx = { name: 'r', members: async () => [] };
  assert.throws(() => createStaticRegistry({ entries: [] as never }, ctx), /entries must be an object/);
  assert.throws(() => createStaticRegistry({ entries: { a: 'x' as never } }, ctx), /entries.a/);
  assert.throws(() => createStaticRegistry({ entries: { a: { tags: [1] as never } } }, ctx), /tags/);
  assert.throws(() => createStaticRegistry({ entries: { a: { skills: [{}] as never } } }, ctx), /skills/);
  assert.throws(() => createStaticRegistry({ entries: { a: { attrs: 'x' as never } } }, ctx), /attrs/);
  assert.throws(() => createStaticRegistry({}, { name: 'r' }), /members/);
});
