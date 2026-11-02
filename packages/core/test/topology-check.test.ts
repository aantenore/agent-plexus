import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TopologyKind, TopologySpec } from '../src/shapes.ts';
import { membersIn, topologyProblems } from '../src/topology-check.ts';

const ALL: TopologyKind[] = ['sequence', 'parallel', 'route', 'loop', 'handoff', 'supervise', 'graph'];
const check = (spec: TopologySpec | string, kinds: TopologyKind[] = ALL, routers = ['router']) => topologyProblems(spec, ['a', 'b'], kinds, routers);

test('a valid topology has no problems', () => {
  assert.deepEqual(check({ kind: 'sequence', steps: ['a', { kind: 'route', candidates: ['b'], fallback: 'a' }] }), []);
});

test('unknown members, with their path', () => {
  assert.deepEqual(check({ kind: 'sequence', steps: ['a', 'zz', { kind: 'parallel', branches: ['yy'] }] }), [
    'root.steps[1]: unknown member "zz"',
    'root.steps[2].branches[0]: unknown member "yy"',
  ]);
});

test('unknown routers: named, and the default when none is configured', () => {
  assert.deepEqual(check({ kind: 'route', candidates: ['a'], router: 'fast' }), ['root: unknown router "fast"']);
  assert.deepEqual(check({ kind: 'route', candidates: ['a'] }, ALL, []), ['root: unknown router "router"']);
  assert.deepEqual(check({ kind: 'handoff', start: 'a', members: ['b'] }, ALL, ['router']), []);
});

test('unsupported kinds', () => {
  assert.deepEqual(check({ kind: 'sequence', steps: [{ kind: 'loop', body: 'a', until: {} }] }, ['sequence']), ['root.steps[0]: kind "loop" is not supported by the topology adapter']);
});

test('handoff and supervise members', () => {
  assert.deepEqual(check({ kind: 'handoff', start: 'q', members: ['a', 'w'] }), ['root.start: unknown member "q"', 'root.members: unknown member "w"']);
  assert.deepEqual(check({ kind: 'supervise', supervisor: 'a', members: ['x'] }), ['root.members: unknown member "x"']);
});

test('graph: unknown nodes and unreachable ends', () => {
  const spec: TopologySpec = {
    kind: 'graph', nodes: { s: 'a', t: 'b', u: 'a' }, start: 's',
    edges: [{ from: 's', to: 't' }, { from: 't', to: 'ghost' }, { from: 'nowhere', to: 's' }],
    end: ['t', 'u', 'missing'],
  };
  const problems = check(spec);
  assert.ok(problems.includes('root.end: unknown graph node "missing"'));
  assert.ok(problems.includes('root.edges[1].to: unknown graph node "ghost"'));
  assert.ok(problems.includes('root.edges[2].from: unknown graph node "nowhere"'));
  assert.ok(problems.includes('root.end: "u" is not reachable from "s"'));
  assert.ok(!problems.some((p) => p.includes('"t" is not reachable')));
});

test('graph node members are checked too', () => {
  assert.deepEqual(check({ kind: 'graph', nodes: { s: 'nope' }, start: 's', edges: [], end: ['s'] }), ['root.nodes.s: unknown member "nope"']);
});

test('membersIn: ids at any depth, route candidates (every member for a filter), handoff and supervise members', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(membersIn({ kind: 'sequence', steps: ['a', { kind: 'route', candidates: ['b'], fallback: 'c' }] }, all).sort(), ['a', 'b', 'c']);
  assert.deepEqual(membersIn({ kind: 'route', candidates: { skills: ['x'] } }, all), all);
  assert.deepEqual(membersIn({ kind: 'handoff', start: 'a', members: ['b'] }, all), ['a', 'b']);
  assert.deepEqual(membersIn({ kind: 'supervise', supervisor: 'd', members: ['e'] }, all), ['d', 'e']);
});
