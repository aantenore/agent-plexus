import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterDescriptor, MemberCapabilities } from '../src/adapter.ts';
import { resolveConfig } from '../src/config.ts';
import type { ExecutionPort } from '../src/ports.ts';
import { prototypeHost } from '../src/prototype-host.ts';
import { readinessFindings, type ReadinessInput } from '../src/readiness.ts';
import type { TopologyNode } from '../src/shapes.ts';

const ALL_KINDS = ['sequence', 'parallel', 'route', 'loop', 'handoff', 'supervise', 'graph'] as const;

const config = (topology: TopologyNode, registry = true) => resolveConfig({
  system: { name: 's' },
  members: { a: { adapter: 'x' }, b: { adapter: 'y' } },
  ports: {
    ...(registry ? { registry: { adapter: 'r' } } : {}),
    router: { adapter: 'k' }, topology: { adapter: 't' }, execution: { adapter: 'e' }, attribution: { adapter: 'at' },
  },
  topology,
}, { cwd: '.' });

const memberAdapter = (name: string, capabilities?: MemberCapabilities): AdapterDescriptor => ({
  fills: 'MemberPort', name, maps: { technology: 'test' }, portVersion: '0.1.0', tiers: ['prototype'],
  ...(capabilities ? { capabilities } : {}), create: () => { throw new Error('unused'); },
}) as AdapterDescriptor;

function findings(topology: TopologyNode, extra: Partial<ReadinessInput> = {}, registry = true) {
  return readinessFindings({
    config: config(topology, registry), host: prototypeHost(), adapters: [], entries: [], topologyKinds: ALL_KINDS, routers: ['router'], ...extra,
  });
}

test('a route or handoff node at any depth fails without ports.registry', () => {
  const route: TopologyNode = { kind: 'route', candidates: ['a', 'b'] };
  const nested: TopologyNode = { kind: 'sequence', steps: ['a', { kind: 'loop', body: route, until: { status: 'completed' } }, { kind: 'handoff', start: 'a', members: ['b'] }] };
  assert.deepEqual(findings(nested, {}, false).map((f) => [f.severity, f.path, f.message]), [
    ['fail', '$.ports.registry', 'root.steps[1].body: a route node needs ports.registry to read its candidates'],
    ['fail', '$.ports.registry', 'root.steps[2]: a handoff node needs ports.registry to read its candidates'],
  ]);
  assert.deepEqual(findings(nested), []);
  assert.deepEqual(findings({ kind: 'sequence', steps: ['a', 'b'] }, {}, false), []);
});

test('a member that declares waits without resume is a warning', () => {
  const adapters = [
    { path: '$.members.a', descriptor: memberAdapter('asks', { waits: true }), options: {} },
    { path: '$.members.b', descriptor: memberAdapter('asks-and-resumes', { waits: true, resume: true }), options: {} },
  ];
  assert.deepEqual(findings({ kind: 'sequence', steps: ['a', 'b'] }, { adapters }).map((f) => [f.severity, f.path, f.message]), [
    ['warn', '$.members.a', 'adapter "asks" declares waits but not resume: a run waiting on member "a" cannot continue'],
  ]);
});

test('join first warns for a racing member that checkpoints without cancel, only under that parallel', () => {
  const adapters = [
    { path: '$.members.a', descriptor: memberAdapter('remote', { checkpoint: true, resume: true }), options: {} },
    { path: '$.members.b', descriptor: memberAdapter('remote-cancel', { checkpoint: true, resume: true, cancel: true }), options: {} },
  ];
  const race: TopologyNode = { kind: 'sequence', steps: [{ kind: 'parallel', join: 'first', branches: [{ kind: 'route', candidates: { skills: ['x'] } }, 'b'] }] };
  assert.deepEqual(findings(race, { adapters }).map((f) => [f.severity, f.path, f.message]), [
    ['warn', '$.topology', 'root.steps[0]: join "first" abandons the losing branches, and member "a" (adapter "remote") checkpoints remote work but declares no cancel: that work keeps running'],
  ]);
  assert.deepEqual(findings({ kind: 'parallel', branches: ['a', 'b'] }, { adapters }), []);
  assert.deepEqual(findings({ kind: 'parallel', join: 'first', branches: ['b'], merge: 'a' }, { adapters }), []);
});

test('an execution port without read is a warning; one with read, or none given, is not', () => {
  const adapters = [{ path: '$.ports.execution', descriptor: { ...memberAdapter('journal'), fills: 'ExecutionPort' } as AdapterDescriptor, options: {} }];
  const port = { name: 'e', begin: async () => { throw new Error('unused'); }, signal: async () => false } as unknown as ExecutionPort;
  assert.deepEqual(findings({ kind: 'sequence', steps: ['a'] }, { adapters, execution: port }).map((f) => [f.severity, f.path, f.message]), [
    ['warn', '$.ports.execution', 'adapter "journal" has no read: stored texts cannot be read back, so attribution cannot trace them and expectations on member outputs cannot be scored'],
  ]);
  assert.deepEqual(findings({ kind: 'sequence', steps: ['a'] }, { adapters, execution: { ...port, read: async () => undefined } }), []);
  assert.deepEqual(findings({ kind: 'sequence', steps: ['a'] }, { adapters }), []);
});

test('a deprecated part of the config is a warning that names its path', () => {
  const deprecated = resolveConfig({
    system: { name: 's' }, members: { a: { adapter: 'x' } },
    ports: { topology: { adapter: 't' }, execution: { adapter: 'e' }, attribution: { adapter: 'at' } },
    topology: { kind: 'sequence', steps: ['a'] }, limits: { registry: { cardTtlMs: 1000 } },
  }, { cwd: '.' });
  const out = readinessFindings({ config: deprecated, host: prototypeHost(), adapters: [], entries: [], topologyKinds: ALL_KINDS, routers: [] });
  assert.deepEqual(out.map((f) => [f.severity, f.path]), [['warn', '$.limits.registry']]);
  assert.match(out[0]!.message, /deprecated and ignored/);
});
