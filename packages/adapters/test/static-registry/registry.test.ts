import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEntry, Attributes, TelemetryHook } from '@agent-plexus/core';
import { adapter, createStaticRegistry, REFUSED_EVENT, type StaticRegistryOptions } from '../../src/static-registry/index.ts';

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

const signed = (id: string, keyId?: string) => entry(id, { trust: { signed: true, ...(keyId ? { keyId } : {}), pinned: true } });

const withTelemetry = (options: StaticRegistryOptions, members: () => Promise<AgentEntry[]>) => {
  const events: { name: string; attrs: Attributes }[] = [];
  const telemetry: TelemetryHook = {
    span: (_name, _attrs, fn) => fn({ set: () => {}, event: () => {} }),
    event: (name, attrs) => void events.push({ name, attrs }),
    metric: () => {},
  };
  return { events, registry: createStaticRegistry(options, { name: 'registry', members, telemetry }) };
};

test('requireSigned: signed entries pass, unsigned ones are refused from get and list', async () => {
  const r = registry({ trust: { requireSigned: true } }, async () => [signed('remote', 'k1'), entry('local')]);
  assert.deepEqual((await r.list()).map((e) => e.id), ['remote']);
  assert.equal((await r.get('remote'))?.id, 'remote');
  assert.equal(await r.get('local'), undefined);
});

test('without a policy, or with requireSigned false, nothing is refused', async () => {
  assert.equal((await registry({}).list()).length, 3);
  assert.equal((await registry({ trust: {} }).list()).length, 3);
  assert.equal((await registry({ trust: { requireSigned: false, exempt: ['triage'] } }).list()).length, 3);
});

test('keyIds: only signatures from the listed keys pass; it implies requireSigned', async () => {
  const members = async () => [signed('a', 'k1'), signed('b', 'k2'), signed('c'), entry('d', { trust: { signed: false, keyId: 'k1', pinned: true } })];
  const r = registry({ trust: { keyIds: ['k1', 'k3'] } }, members);
  assert.deepEqual((await r.list()).map((e) => e.id), ['a']);
  assert.equal(await r.get('b'), undefined);
  assert.equal(await r.get('c'), undefined);
  assert.equal(await r.get('d'), undefined);
});

test('exempt members pass without a signature; exemption does not leak to others', async () => {
  const r = registry({ trust: { requireSigned: true, keyIds: ['k1'], exempt: ['local', 'ghost'] } }, async () => [entry('local'), entry('other'), signed('remote', 'k1')]);
  assert.deepEqual((await r.list()).map((e) => e.id), ['local', 'remote']);
});

test('an entry without trust is refused', async () => {
  const noTrust = { ...entry('x'), trust: undefined } as unknown as AgentEntry;
  const r = registry({ trust: { requireSigned: true } }, async () => [noTrust]);
  assert.deepEqual(await r.list(), []);
  assert.equal(await r.get('x'), undefined);
});

test('filters apply after the policy', async () => {
  const r = registry({ trust: { requireSigned: true } }, async () => [signed('a'), entry('b')]);
  assert.deepEqual((await r.list({ attrs: { region: 'eu' } })).map((e) => e.id), []);
});

test('a refusal is reported once per entry state, with the member and reason only', async () => {
  let members = [entry('local'), signed('remote', 'bad')];
  const { events, registry: r } = withTelemetry({ trust: { keyIds: ['k1'] } }, async () => members);
  await r.list();
  await r.list();
  await r.get('local');
  await r.get('remote');
  assert.deepEqual(events.map((e) => [e.name, e.attrs['plexus.member'], e.attrs['plexus.registry.reason']]), [
    [REFUSED_EVENT, 'local', 'unsigned'],
    [REFUSED_EVENT, 'remote', 'key'],
  ]);
  assert.equal(events[0]?.attrs['plexus.layer'], 'registry');
  assert.deepEqual(Object.keys(events[1]?.attrs ?? {}).sort(), ['plexus.layer', 'plexus.member', 'plexus.registry.reason']);
  // the key changes: refused again; accepted then refused again: reported again
  members = [entry('local'), signed('remote', 'bad2')];
  await r.list();
  members = [signed('local', 'k1'), signed('remote', 'k1')];
  await r.list();
  members = [entry('local'), signed('remote', 'k1')];
  await r.list();
  assert.equal(events.length, 4);
  assert.deepEqual(events.slice(2).map((e) => [e.attrs['plexus.member'], e.attrs['plexus.registry.reason']]), [['remote', 'key'], ['local', 'unsigned']]);
});

test('accepted entries and exempt members report nothing', async () => {
  const { events, registry: r } = withTelemetry({ trust: { requireSigned: true, exempt: ['local'] } }, async () => [entry('local'), signed('remote', 'k1')]);
  await r.list();
  assert.deepEqual(events, []);
});

test('invalid trust options fail at create time', () => {
  const ctx = { name: 'r', members: async () => [] };
  assert.throws(() => createStaticRegistry({ trust: [] as never }, ctx), /trust must be an object/);
  assert.throws(() => createStaticRegistry({ trust: { requireSigned: 'yes' as never } }, ctx), /requireSigned/);
  assert.throws(() => createStaticRegistry({ trust: { keyIds: 'k1' as never } }, ctx), /keyIds/);
  assert.throws(() => createStaticRegistry({ trust: { keyIds: [''] } }, ctx), /keyIds/);
  assert.throws(() => createStaticRegistry({ trust: { keyIds: [] } }, ctx), /keyIds must not be empty/);
  assert.throws(() => createStaticRegistry({ trust: { exempt: [1] as never } }, ctx), /exempt/);
});

test('the options schema describes trust and rejects unknown keys', () => {
  const trust = adapter.optionsSchema?.properties?.trust;
  assert.equal(trust?.additionalProperties, false);
  assert.deepEqual(Object.keys(trust?.properties ?? {}), ['requireSigned', 'keyIds', 'exempt']);
  assert.equal(trust?.properties?.keyIds?.items?.minLength, 1);
  assert.equal(trust?.properties?.exempt?.items?.minLength, 1);
});
