import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assemble, defineAdapter, inputText, PORT_VERSIONS, prototypeHost, resolveConfig, type AdapterDescriptor, type CallOptions, type Condition,
  type Execution, type MemberResult, type RouteDecision, type RouteRequest, type RunInput, type RunScope, type TopologyLimits, type TopologySpec,
} from '@agent-plexus/core';
import { adapter, createBasicTopology } from '../../src/basic-topology/index.ts';

type Reply = (member: string, input: RunInput, options: CallOptions, n: number) => MemberResult | Promise<MemberResult>;

interface Call { member: string; input: RunInput; options: CallOptions; hopId: string }

const ok = (output: string, extra: Partial<MemberResult> = {}): MemberResult => ({ status: 'completed', output, ...extra });
const failed = (output = ''): MemberResult => ({ status: 'failed', output, reason: { code: 'error' } });
const echo: Reply = (member, input) => ok(`${member}(${typeof input === 'string' ? input : input.text})`);

function fakeScope(reply: Reply = echo, extra: { input?: RunInput; limits?: Partial<TopologyLimits>; route?: (r: RouteRequest) => RouteDecision; signal?: AbortSignal } = {}) {
  const calls: Call[] = [];
  const routes: RouteRequest[] = [];
  const abandoned: string[] = [];
  const state = { active: 0, maxActive: 0 };
  const scope: RunScope = {
    ctx: { runId: 'r1', system: 'test', ...(extra.signal ? { signal: extra.signal } : {}) },
    input: extra.input ?? 'original',
    limits: { maxParallel: 4, maxIterations: 5, maxHandoffs: 10, ...extra.limits },
    async call(member, input, options) {
      const hopId = `h${calls.length + 1}`;
      calls.push({ member, input, options, hopId });
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        return { hopId, result: await reply(member, input, options, calls.length) };
      } finally {
        state.active--;
      }
    },
    async route(request) {
      routes.push(request);
      return extra.route ? extra.route(request) : {};
    },
    matches: (condition: Condition, result) => (condition.matches ? new RegExp(condition.matches).test(result.output) : condition.status === result.status),
    abandon: (hopId) => void abandoned.push(hopId),
  };
  return { scope, calls, routes, abandoned, state };
}

const run = (spec: TopologySpec, scope: RunScope, input: RunInput = 'in') =>
  Promise.resolve(createBasicTopology().bind(spec, { system: 'test', members: [] })).then((bound) => bound.run(input, scope));

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test('descriptor fills TopologyPort with the supported kinds', () => {
  assert.equal(adapter.fills, 'TopologyPort');
  assert.equal(adapter.name, 'basic-topology');
  assert.deepEqual(adapter.tiers, ['prototype', 'production']);
  assert.deepEqual(adapter.maps, { technology: 'in-process topology executor' });
  assert.deepEqual([...createBasicTopology().kinds], ['sequence', 'route', 'loop', 'parallel', 'handoff', 'supervise', 'graph']);
});

test('sequence chains outputs and reports step paths', async () => {
  const { scope, calls } = fakeScope();
  const result = await run({ kind: 'sequence', steps: ['a', 'b', 'c'] }, scope);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'c(b(a(in)))');
  assert.deepEqual(calls.map((c) => c.options.node), ['root.steps[0]', 'root.steps[1]', 'root.steps[2]']);
});

test('nested nodes get nested paths', async () => {
  const { scope, calls } = fakeScope();
  await run({ kind: 'sequence', steps: ['a', { kind: 'sequence', steps: ['b', 'c'] }] }, scope);
  assert.deepEqual(calls.map((c) => c.options.node), ['root.steps[0]', 'root.steps[1].steps[0]', 'root.steps[1].steps[1]']);
});

test('input "original" feeds the node the system input', async () => {
  const { scope, calls } = fakeScope(echo, { input: 'ORIG' });
  const result = await run({ kind: 'sequence', steps: ['a', { kind: 'sequence', input: 'original', steps: ['b'] }] }, scope);
  assert.equal(calls[0]?.input, 'in');
  assert.equal(calls[1]?.input, 'ORIG');
  assert.equal(result.output, 'b(ORIG)');
});

test('sequence stops at the first step that is not completed', async () => {
  const { scope, calls } = fakeScope((member) => (member === 'b' ? failed('bad') : ok(member)));
  const result = await run({ kind: 'sequence', steps: ['a', 'b', 'c'] }, scope);
  assert.equal(result.status, 'failed');
  assert.equal(result.output, 'bad');
  assert.equal(calls.length, 2);
});

test('sequence sums usage and cost', async () => {
  const { scope } = fakeScope((member) => ok(member, { usage: { inputTokens: 10, outputTokens: 2 }, costUsd: 0.5 }));
  const result = await run({ kind: 'sequence', steps: ['a', 'b', 'c'] }, scope);
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 6 });
  assert.equal(result.costUsd, 1.5);
  const bare = await run({ kind: 'sequence', steps: ['a'] }, fakeScope().scope);
  assert.equal('usage' in bare, false);
  assert.equal('costUsd' in bare, false);
});

test('route calls the chosen member and passes the request', async () => {
  const { scope, calls, routes } = fakeScope(echo, { route: () => ({ member: 'billing' }) });
  const result = await run({ kind: 'route', candidates: ['billing', 'sales'], router: 'skills' }, scope);
  assert.equal(result.output, 'billing(in)');
  assert.deepEqual(routes, [{ input: 'in', candidates: ['billing', 'sales'], router: 'skills', node: 'root' }]);
  assert.equal(calls[0]?.options.node, 'root');
});

test('route passes the decision to the call, without its reason', async () => {
  const ranked = [{ member: 'billing', score: 0.9 }, { member: 'sales', score: 0.2 }];
  const { scope, calls } = fakeScope(echo, { route: () => ({ member: 'billing', ranked, reason: 'internal' }) });
  await run({ kind: 'route', candidates: ['billing', 'sales'] }, scope);
  assert.deepEqual(calls[0]?.options.route, { member: 'billing', ranked });

  const plain = fakeScope(echo, { route: () => ({ member: 'billing' }) });
  await run({ kind: 'route', candidates: ['billing'] }, plain.scope);
  assert.deepEqual(plain.calls[0]?.options.route, { member: 'billing' });

  const fallback = fakeScope();
  await run({ kind: 'route', candidates: ['a'], fallback: 'triage' }, fallback.scope);
  assert.equal(fallback.calls[0]?.options.route, undefined);
});

test('route without a member runs the fallback, else stops as rejected', async () => {
  const withFallback = fakeScope();
  const r1 = await run({ kind: 'route', candidates: { tags: ['x'] }, fallback: 'triage' }, withFallback.scope);
  assert.equal(r1.output, 'triage(in)');
  assert.equal(withFallback.calls[0]?.options.node, 'root.fallback');
  assert.equal('router' in withFallback.routes[0]!, false);

  const none = fakeScope();
  const r2 = await run({ kind: 'route', candidates: ['a'] }, none.scope);
  assert.deepEqual(r2, { status: 'stopped', output: '', reason: { code: 'rejected', layer: 'routing' } });
  assert.equal(none.calls.length, 0);
});

test('loop ends when the condition holds and numbers iterations from 1', async () => {
  const { scope, calls } = fakeScope((member, input, options, n) => ok(n >= 3 ? 'done' : 'more'));
  const result = await run({ kind: 'loop', body: 'worker', until: { matches: 'done' } }, scope);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.map((c) => c.options.node), ['root.body#1', 'root.body#2', 'root.body#3']);
  assert.equal(calls[1]?.input, 'more');
});

test('loop stops with limit when the bound is reached', async () => {
  const node = fakeScope(() => ok('more', { costUsd: 1 }));
  const r1 = await run({ kind: 'loop', body: 'w', until: { matches: 'done' }, maxIterations: 2 }, node.scope);
  assert.equal(r1.status, 'stopped');
  assert.equal(r1.reason?.code, 'limit');
  assert.equal(r1.reason?.layer, 'topology');
  assert.equal(r1.costUsd, 2);
  assert.equal(node.calls.length, 2);

  const dflt = fakeScope(() => ok('more'), { limits: { maxIterations: 3 } });
  const r2 = await run({ kind: 'loop', body: 'w', until: { matches: 'done' } }, dflt.scope);
  assert.equal(dflt.calls.length, 3);
  assert.deepEqual(r2.reason, { code: 'limit', layer: 'topology', by: 'limits.system.maxIterations' });
});

test('loop ends with a body result that is not completed', async () => {
  const { scope, calls } = fakeScope((_m, _i, _o, n) => (n === 2 ? failed('boom') : ok('more')));
  const result = await run({ kind: 'loop', body: 'w', until: { matches: 'done' } }, scope);
  assert.equal(result.status, 'failed');
  assert.equal(calls.length, 2);
});

test('parallel respects maxParallel and gives each branch an even share', async () => {
  const { scope, calls, state } = fakeScope(async (member) => {
    await tick();
    return ok(member);
  }, { limits: { maxParallel: 2 } });
  const result = await run({ kind: 'parallel', branches: ['a', 'b', 'c', 'd', 'e'] }, scope);
  assert.equal(result.status, 'completed');
  assert.equal(state.maxActive, 2);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((c) => c.options.share === 0.2));
  assert.deepEqual(calls.map((c) => c.options.node).sort(), [0, 1, 2, 3, 4].map((i) => `root.branches[${i}]`));
});

test('parallel join all concatenates branch outputs in order', async () => {
  const { scope } = fakeScope(async (member) => {
    if (member === 'a') await tick();
    return ok(member.toUpperCase(), { costUsd: 1 });
  });
  const result = await run({ kind: 'parallel', branches: ['a', { kind: 'sequence', steps: ['b'] }] }, scope);
  assert.equal(result.output, '[a]\nA\n\n[root.branches[1]]\nB');
  assert.equal(result.costUsd, 2);
});

test('parallel join all feeds the merge node', async () => {
  const { scope, calls } = fakeScope((member, input) => ok(member === 'm' ? `merged:${String(input).length}` : member));
  const result = await run({ kind: 'parallel', branches: ['a', 'b'], merge: 'm' }, scope);
  assert.equal(calls.at(-1)?.member, 'm');
  assert.equal(calls.at(-1)?.options.node, 'root.merge');
  assert.equal(calls.at(-1)?.input, '[a]\na\n\n[b]\nb');
  assert.equal(result.output, 'merged:12');
});

test('parallel join all returns the first non-completed branch by order', async () => {
  const { scope, calls } = fakeScope(async (member) => {
    if (member === 'b') await tick();
    return member === 'a' ? ok('a') : failed(member);
  });
  const result = await run({ kind: 'parallel', branches: ['a', 'b', 'c'], merge: 'm' }, scope);
  assert.equal(result.status, 'failed');
  assert.equal(result.output, 'b');
  assert.equal(calls.some((c) => c.member === 'm'), false);
});

test('a waiting result keeps the wait the core named on it through sequence, parallel, loop and graph', async () => {
  const waiting = (member: string): MemberResult => ({ status: 'waiting', output: '', reason: { code: 'needs_input' }, wait: { token: `call:${member}:0#0`, kind: 'input', member } });
  const { scope } = fakeScope(async (member) => {
    if (member === 'w1') await tick();
    return member.startsWith('w') ? waiting(member) : ok(member);
  });
  const specs: TopologySpec[] = [
    { kind: 'sequence', steps: ['a', 'w1', 'b'] },
    { kind: 'parallel', branches: ['a', 'w1', 'w2'] },
    { kind: 'loop', body: 'w1', until: { status: 'completed' } },
    { kind: 'graph', start: 'w2', nodes: { w2: 'w2', w1: 'w1' }, edges: [{ from: 'w2', to: 'w1', when: { status: 'waiting' } }], end: ['w1'] },
  ];
  for (const spec of specs) assert.deepEqual((await run(spec, scope)).wait, { token: 'call:w1:0#0', kind: 'input', member: 'w1' }, spec.kind);
});

test('parallel join first returns the first completed, aborts and abandons the rest', async () => {
  const { scope, abandoned, calls } = fakeScope((member, _input, options) => {
    if (member === 'fast') return ok('fast');
    return new Promise<MemberResult>((resolve) => {
      options.signal?.addEventListener('abort', () => resolve({ status: 'stopped', output: '', reason: { code: 'aborted' } }));
    });
  });
  const result = await run({ kind: 'parallel', join: 'first', branches: ['slow1', 'fast', 'slow2'] }, scope);
  assert.equal(result.output, 'fast');
  assert.equal(calls.length, 3);
  const hop = (member: string) => calls.find((c) => c.member === member)!.hopId;
  assert.deepEqual([...abandoned].sort(), [hop('slow1'), hop('slow2')].sort());
  assert.equal(calls.find((c) => c.member === 'slow1')!.options.signal?.aborted, true);
});

test('parallel join all: a thrown branch aborts the siblings, waits for them and abandons their hops', async () => {
  const started = Date.now();
  const { scope, abandoned, calls } = fakeScope((member, _input, options) => {
    if (member === 'bad') throw new Error('boom');
    return new Promise<MemberResult>((resolve) => {
      const timer = setTimeout(() => resolve(ok(member)), 5000);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve({ status: 'stopped', output: '', reason: { code: 'aborted' } });
      });
    });
  });
  await assert.rejects(run({ kind: 'parallel', branches: ['slow', 'bad'] }, scope), /boom/);
  assert.ok(Date.now() - started < 2000);
  const slow = calls.find((c) => c.member === 'slow')!;
  assert.equal(slow.options.signal?.aborted, true);
  assert.deepEqual(abandoned, [slow.hopId]);
});

test('parallel join first does not start branches after a winner', async () => {
  const { scope, calls, abandoned } = fakeScope(() => ok('x'), { limits: { maxParallel: 1 } });
  const result = await run({ kind: 'parallel', join: 'first', branches: ['a', 'b', 'c'] }, scope);
  assert.equal(result.output, 'x');
  assert.equal(calls.length, 1);
  assert.deepEqual(abandoned, []);
});

test('parallel join first falls back to the first non-completed when none completes', async () => {
  const { scope, abandoned } = fakeScope((member) => failed(member));
  const result = await run({ kind: 'parallel', join: 'first', branches: ['a', 'b'] }, scope);
  assert.equal(result.status, 'failed');
  assert.equal(result.output, 'a');
  assert.deepEqual(abandoned, []);
});

test('unsupported kinds are rejected at bind, naming the kind', () => {
  const topology = createBasicTopology();
  const info = { system: 'test', members: [] };
  const swarm = { kind: 'swarm', members: ['a'] } as unknown as TopologySpec;
  assert.throws(() => topology.bind(swarm, info), /swarm/);
  assert.throws(() => topology.bind({ kind: 'sequence', steps: ['a', swarm] }, info), /root\.steps\[1\].*swarm/);
});

test('malformed specs are rejected at bind', () => {
  const topology = createBasicTopology();
  const info = { system: 'test', members: [] };
  assert.throws(() => topology.bind({ kind: 'sequence', steps: [] }, info), /steps/);
  assert.throws(() => topology.bind({ kind: 'loop', body: 'a', until: {}, maxIterations: 0 }, info), /maxIterations/);
  assert.throws(() => topology.bind({ kind: 'handoff', start: '', members: ['a'] }, info), /start/);
  assert.throws(() => topology.bind({ kind: 'handoff', start: 'a', members: [] }, info), /members/);
  assert.throws(() => topology.bind({ kind: 'handoff', start: 'a', members: ['a'], maxHandoffs: 0 }, info), /maxHandoffs/);
  assert.throws(() => topology.bind({ kind: 'supervise', supervisor: '', members: ['a'] }, info), /supervisor/);
  assert.throws(() => topology.bind({ kind: 'supervise', supervisor: 's', members: [] }, info), /members/);
  assert.throws(() => topology.bind({ kind: 'graph', nodes: {}, start: 'a', edges: [], end: [] }, info), /nodes/);
  assert.throws(() => topology.bind({ kind: 'graph', nodes: { a: 'a' }, start: 'b', edges: [], end: ['a'] }, info), /"start" names unknown node "b"/);
  assert.throws(() => topology.bind({ kind: 'graph', nodes: { a: 'a' }, start: 'a', edges: [{ from: 'a', to: 'z' }], end: ['a'] }, info), /edges\[0\]\.to names unknown node "z"/);
  assert.throws(() => topology.bind({ kind: 'graph', nodes: { a: 'a' }, start: 'a', edges: [], end: ['q'] }, info), /end\[0\]/);
  assert.throws(
    () => topology.bind({ kind: 'graph', nodes: { a: { kind: 'sequence', steps: [] } }, start: 'a', edges: [], end: ['a'] }, info),
    /root\.nodes\.a.*steps/,
  );
});

test('an aborted run stops with aborted and calls nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const { scope, calls } = fakeScope(echo, { signal: controller.signal });
  const result = await run({ kind: 'sequence', steps: ['a', 'b'] }, scope);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason?.code, 'aborted');
  assert.equal(calls.length, 0);
});

test('aborting between steps stops the sequence', async () => {
  const controller = new AbortController();
  const { scope, calls } = fakeScope((member) => {
    controller.abort();
    return ok(member);
  }, { signal: controller.signal });
  const result = await run({ kind: 'sequence', steps: ['a', 'b'] }, scope);
  assert.equal(result.reason?.code, 'aborted');
  assert.equal(calls.length, 1);
});

const handoffTo = (member: string): Partial<MemberResult> => ({ ext: { 'plexus.handoff': member } });

test('handoff follows the member that names the next one, passing the output on', async () => {
  const { scope, calls, routes } = fakeScope((member) => (member === 'a' ? ok('from a', handoffTo('b')) : member === 'b' ? ok('from b', handoffTo('c')) : ok('final')));
  const result = await run({ kind: 'handoff', start: 'a', members: ['a', 'b', 'c'] }, scope);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'final');
  assert.deepEqual(calls.map((c) => c.member), ['a', 'b', 'c']);
  assert.deepEqual(calls.map((c) => c.input), ['in', 'from a', 'from b']);
  assert.deepEqual(calls.map((c) => c.options.node), ['root.turns[0]', 'root.turns[1]', 'root.turns[2]']);
  assert.deepEqual(routes, []);
});

test('handoff uses the router when the member names nobody, without the current member', async () => {
  const ranked = [{ member: 'b', score: 1 }];
  const { scope, calls, routes } = fakeScope(
    (member, _input, _options, n) => ok(`${member}${n}`),
    { route: (r) => (r.input === 'a1' ? { member: 'b', ranked } : {}) },
  );
  const result = await run({ kind: 'handoff', start: 'a', members: ['a', 'b', 'c'], router: 'skills' }, scope);
  assert.equal(result.output, 'b2');
  assert.deepEqual(routes, [
    { input: 'a1', candidates: ['b', 'c'], router: 'skills', node: 'root.turns[1]', optional: true },
    { input: 'b2', candidates: ['a', 'c'], router: 'skills', node: 'root.turns[2]', optional: true },
  ]);
  assert.deepEqual(calls.map((c) => c.member), ['a', 'b']);
  assert.deepEqual(calls[1]?.options.route, { member: 'b', ranked });
  assert.equal(calls[1]?.options.node, 'root.turns[1]');
});

test('a member that names the next one takes precedence over the router', async () => {
  const { scope, calls, routes } = fakeScope((member) => (member === 'a' ? ok('x', handoffTo('c')) : ok('end')), { route: () => ({}) });
  await run({ kind: 'handoff', start: 'a', members: ['a', 'b', 'c'], router: 'skills' }, scope);
  assert.deepEqual(calls.map((c) => c.member), ['a', 'c']);
  assert.deepEqual(routes.map((r) => r.node), ['root.turns[2]'], 'only the turn without a named successor is routed');
});

test('handoff finishes when nobody is named and there is no router or no pick', async () => {
  const plain = fakeScope();
  const first = await run({ kind: 'handoff', start: 'a', members: ['a', 'b'] }, plain.scope);
  assert.equal(first.output, 'a(in)');
  assert.equal(plain.calls.length, 1);

  const routed = fakeScope(echo, { route: () => ({}) });
  const second = await run({ kind: 'handoff', start: 'a', members: ['a', 'b'], router: 'skills' }, routed.scope);
  assert.equal(second.output, 'a(in)');
  assert.equal(routed.calls.length, 1);

  const alone = fakeScope(echo, { route: () => ({ member: 'a' }) });
  await run({ kind: 'handoff', start: 'a', members: ['a'], router: 'skills' }, alone.scope);
  assert.deepEqual(alone.routes, [], 'no candidates left, so nobody is asked');
});

test('handoff to something that is not a member is rejected, naming it', async () => {
  const { scope, calls } = fakeScope((member) => ok(member, handoffTo('ghost')), { route: () => ({ member: 'b' }) });
  const result = await run({ kind: 'handoff', start: 'a', members: ['a', 'b'], router: 'skills' }, scope);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason?.code, 'rejected');
  assert.equal(result.reason?.layer, 'topology');
  assert.match(result.reason?.detail ?? '', /ghost/);
  assert.equal(calls.length, 1);

  const odd = fakeScope(() => ok('x', { ext: { 'plexus.handoff': 7 } }));
  const bad = await run({ kind: 'handoff', start: 'a', members: ['a'] }, odd.scope);
  assert.equal(bad.reason?.code, 'rejected');
});

test('handoff is bounded by the system limit, then by its own maxHandoffs', async () => {
  const pingPong = (member: string): MemberResult => ok(`${member}!`, handoffTo(member === 'a' ? 'b' : 'a'));
  const system = fakeScope(pingPong, { limits: { maxHandoffs: 2 } });
  const stoppedBySystem = await run({ kind: 'handoff', start: 'a', members: ['a', 'b'] }, system.scope);
  assert.equal(stoppedBySystem.status, 'stopped');
  assert.deepEqual(stoppedBySystem.reason, { code: 'limit', layer: 'topology', by: 'limits.system.maxHandoffs' });
  assert.equal(system.calls.length, 3, 'the first turn plus two handoffs');

  const own = fakeScope(pingPong);
  const stoppedByNode = await run({ kind: 'sequence', steps: [{ kind: 'handoff', start: 'a', members: ['a', 'b'], maxHandoffs: 1 }] }, own.scope);
  assert.deepEqual(stoppedByNode.reason, { code: 'limit', layer: 'topology', by: 'root.steps[0].maxHandoffs' });
  assert.equal(own.calls.length, 2);
});

test('a turn that is not completed ends the handoff with its result', async () => {
  const { scope, calls } = fakeScope((member) => (member === 'b' ? failed('broke') : ok(member, handoffTo('b'))));
  const result = await run({ kind: 'handoff', start: 'a', members: ['a', 'b', 'c'] }, scope);
  assert.equal(result.status, 'failed');
  assert.equal(result.output, 'broke');
  assert.equal(calls.length, 2);
});

test('handoff sums usage and honours input "original"', async () => {
  const { scope, calls } = fakeScope(
    (member) => ok(member, { usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1, ...(member === 'a' ? handoffTo('b') : {}) }),
    { input: 'ORIG' },
  );
  const result = await run({ kind: 'sequence', steps: ['pre', { kind: 'handoff', input: 'original', start: 'a', members: ['a', 'b'] }] }, scope);
  assert.equal(calls[1]?.input, 'ORIG');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 3 });
  assert.equal(result.costUsd, 3);
});

test('graph runs nodes along unconditional edges and finishes at an end node', async () => {
  const { scope, calls } = fakeScope();
  const result = await run({
    kind: 'graph',
    start: 'one',
    nodes: { one: 'a', two: { kind: 'sequence', steps: ['b', 'c'] }, three: 'd' },
    edges: [{ from: 'one', to: 'two' }, { from: 'two', to: 'three' }],
    end: ['three'],
  }, scope);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'd(c(b(a(in))))');
  assert.deepEqual(calls.map((c) => c.options.node), ['root.nodes.one', 'root.nodes.two.steps[0]', 'root.nodes.two.steps[1]', 'root.nodes.three']);
});

test('graph takes the first edge whose condition holds on the output', async () => {
  const spec = (): TopologySpec => ({
    kind: 'graph',
    start: 'triage',
    nodes: { triage: 'triage', billing: 'billing', manuals: 'manuals', other: 'other' },
    edges: [
      { from: 'triage', to: 'billing', when: { matches: 'invoice' } },
      { from: 'triage', to: 'manuals', when: { matches: 'manual' } },
      { from: 'triage', to: 'other' },
    ],
    end: ['billing', 'manuals', 'other'],
  });
  for (const [text, expected] of [['invoice and manual', 'billing'], ['a manual', 'manuals'], ['nothing', 'other']] as const) {
    const { scope, calls } = fakeScope((member) => ok(member === 'triage' ? text : member));
    const result = await run(spec(), scope);
    assert.equal(result.output, expected);
    assert.deepEqual(calls.map((c) => c.member), ['triage', expected]);
    assert.equal(calls[1]?.input, text);
  }
});

test('graph follows a failure edge to a recovery node, and unconditional edges ignore failures', async () => {
  const spec: TopologySpec = {
    kind: 'graph',
    start: 'work',
    nodes: { work: 'work', recover: 'recover', done: 'done' },
    edges: [
      { from: 'work', to: 'recover', when: { status: 'failed', code: 'error' } },
      { from: 'work', to: 'done' },
      { from: 'recover', to: 'done' },
    ],
    end: ['done'],
  };
  const failing = fakeScope((member) => (member === 'work' ? failed('boom') : ok(member)));
  const recovered = await run(spec, failing.scope);
  assert.equal(recovered.status, 'completed');
  assert.deepEqual(failing.calls.map((c) => c.member), ['work', 'recover', 'done']);
  assert.equal(failing.calls[1]?.input, 'boom');

  const noRecovery = { ...spec, edges: spec.edges.slice(1) } as TopologySpec;
  const plain = fakeScope((member) => (member === 'work' ? failed('boom') : ok(member)));
  const result = await run(noRecovery, plain.scope);
  assert.equal(result.status, 'failed');
  assert.equal(result.output, 'boom');
  assert.equal(plain.calls.length, 1);
});

test('graph without an applicable edge finishes at an end node and is rejected elsewhere', async () => {
  const spec = (end: string[]): TopologySpec => ({
    kind: 'graph',
    start: 'a',
    nodes: { a: 'a', b: 'b' },
    edges: [{ from: 'a', to: 'b', when: { matches: 'go' } }],
    end,
  });
  const atEnd = await run(spec(['a', 'b']), fakeScope().scope);
  assert.equal(atEnd.status, 'completed');
  assert.equal(atEnd.output, 'a(in)');

  const stuck = fakeScope();
  const rejected = await run(spec(['b']), stuck.scope);
  assert.equal(rejected.status, 'stopped');
  assert.equal(rejected.reason?.code, 'rejected');
  assert.equal(rejected.reason?.layer, 'topology');
  assert.match(rejected.reason?.detail ?? '', /graph node a has no edge for this result/);
  assert.equal(stuck.calls.length, 1);
});

test('graph returns a node result that is not completed, even at an end node', async () => {
  const { scope } = fakeScope(() => failed('bad'));
  const result = await run({ kind: 'graph', start: 'a', nodes: { a: 'a' }, edges: [], end: ['a'] }, scope);
  assert.equal(result.status, 'failed');
  assert.equal(result.output, 'bad');
});

test('graph cycles are bounded by maxIterations visits per node', async () => {
  const spec: TopologySpec = {
    kind: 'graph',
    start: 'a',
    nodes: { a: 'a', b: 'b' },
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    end: ['b'],
  };
  const { scope, calls } = fakeScope(echo, { limits: { maxIterations: 3 } });
  const result = await run(spec, scope);
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.reason, { code: 'limit', layer: 'topology', by: 'limits.system.maxIterations' });
  assert.deepEqual(calls.map((c) => c.member), ['a', 'b', 'a', 'b', 'a', 'b']);
});

test('graph calls a node again when it is revisited, with its own path', async () => {
  const spec: TopologySpec = {
    kind: 'graph',
    start: 'work',
    nodes: { work: 'work', check: 'check', done: 'done' },
    edges: [
      { from: 'work', to: 'check' },
      { from: 'check', to: 'work', when: { matches: 'retry' } },
      { from: 'check', to: 'done' },
    ],
    end: ['done'],
  };
  let checks = 0;
  const { scope, calls } = fakeScope((member) => (member === 'check' ? ok(++checks < 2 ? 'retry' : 'fine') : ok(member)));
  const result = await run(spec, scope);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.map((c) => c.member), ['work', 'check', 'work', 'check', 'done']);
  assert.deepEqual(calls.map((c) => c.options.node), ['root.nodes.work', 'root.nodes.check', 'root.nodes.work#2', 'root.nodes.check#2', 'root.nodes.done']);
  assert.equal(new Set(calls.map((c) => c.options.node)).size, calls.length);
});

test('graph nodes honour input "original" and the graph sums usage', async () => {
  const { scope, calls } = fakeScope((member) => ok(member, { usage: { inputTokens: 2, outputTokens: 1 }, costUsd: 0.25 }), { input: 'ORIG' });
  const result = await run({
    kind: 'graph',
    start: 'a',
    nodes: { a: 'a', b: { kind: 'sequence', input: 'original', steps: ['b'] } },
    edges: [{ from: 'a', to: 'b' }],
    end: ['b'],
  }, scope);
  assert.equal(calls[0]?.input, 'in');
  assert.equal(calls[1]?.input, 'ORIG');
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2 });
  assert.equal(result.costUsd, 0.5);
});

test('handoff and graph stop at once when the run is aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const { scope, calls } = fakeScope(echo, { signal: controller.signal });
  const handed = await run({ kind: 'handoff', start: 'a', members: ['a'] }, scope);
  assert.equal(handed.reason?.code, 'aborted');
  const walked = await run({ kind: 'graph', start: 'a', nodes: { a: 'a' }, edges: [], end: ['a'] }, scope);
  assert.equal(walked.reason?.code, 'aborted');
  assert.equal(calls.length, 0);
});

/** A system over basic-topology with in-process members, a registry of them, a router and a journal that keeps nothing. */
async function assembled(topology: TopologySpec, router: (candidates: string[]) => RouteDecision) {
  const tiers = ['prototype'] as const;
  const maps = { technology: 'test' };
  const member = defineAdapter<'MemberPort', { fail?: boolean }>({
    fills: 'MemberPort', name: 'test-member', maps, tiers: [...tiers], portVersion: PORT_VERSIONS.MemberPort,
    create: (o, ctx) => ({
      name: ctx.name,
      describe: async () => ({ id: ctx.name, name: ctx.name, description: ctx.name, skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: false } }),
      invoke: async (input) => (o.fail ? failed(`${ctx.name} broke`) : ok(`${ctx.name}(${inputText(input)})`)),
    }),
  });
  const registry = defineAdapter({
    fills: 'RegistryPort', name: 'test-registry', maps, tiers: [...tiers], portVersion: PORT_VERSIONS.RegistryPort,
    create: (_o, ctx) => ({ name: 'test-registry', list: async () => ctx.members!(), get: async (id: string) => (await ctx.members!()).find((e) => e.id === id) }),
  });
  const routerAdapter = defineAdapter({
    fills: 'AgentRouterPort', name: 'test-router', maps, tiers: [...tiers], portVersion: PORT_VERSIONS.AgentRouterPort,
    create: () => ({ name: 'test-router', route: async (q) => router(q.candidates.map((c) => c.id)) }),
  });
  const execution = defineAdapter({
    fills: 'ExecutionPort', name: 'test-execution', maps, tiers: [...tiers], portVersion: PORT_VERSIONS.ExecutionPort,
    create: () => ({
      name: 'test-execution',
      begin: async (runKey): Promise<Execution> => ({
        runKey, step: (_name, fn) => fn(), wait: async () => undefined, put: async () => 'text', remember: async () => {}, recall: async () => undefined, end: async () => {},
      }),
      signal: async () => false,
    }),
  });
  const attribution = defineAdapter({
    fills: 'AttributionPort', name: 'test-attribution', maps, tiers: [...tiers], portVersion: PORT_VERSIONS.AttributionPort,
    create: () => ({ name: 'test-attribution', attribute: async () => [] }),
  });
  const all = [member, registry, routerAdapter, execution, attribution, adapter] as unknown as AdapterDescriptor[];
  const config = resolveConfig({
    system: { name: 'handoffs' },
    members: { a: { adapter: 'test-member' }, b: { adapter: 'test-member' }, c: { adapter: 'test-member', options: { fail: true } } },
    ports: {
      registry: { adapter: 'test-registry' }, router: { adapter: 'test-router' }, topology: { adapter: 'basic-topology' },
      execution: { adapter: 'test-execution' }, attribution: { adapter: 'test-attribution' },
    },
    topology,
  }, { cwd: process.cwd() });
  return assemble(config, {
    host: prototypeHost({ quiet: true }),
    resolveAdapter: async (fills, name) => {
      const found = all.find((d) => d.fills === fills && d.name === name);
      if (!found) throw new Error('is not installed');
      return found;
    },
  });
}

test('a handoff whose router chooses nobody ends without a routing hop, so a later failure is not routing', async () => {
  const handoff: TopologySpec = { kind: 'handoff', start: 'a', members: ['a', 'b'], router: 'router' };
  const asked: string[][] = [];
  const ended = await (await assembled(handoff, (candidates) => (asked.push(candidates), {}))).run('in');
  assert.deepEqual(asked, [['b']]);
  assert.equal(ended.status, 'completed');
  assert.deepEqual(ended.record.map((h) => [h.member, h.status]), [['a', 'completed']]);

  const later = await (await assembled({ kind: 'sequence', steps: [handoff, 'c'] }, () => ({}))).run('in');
  assert.equal(later.status, 'failed');
  assert.deepEqual(later.record.map((h) => [h.member, h.status]), [['a', 'completed'], ['c', 'failed']]);
  assert.equal(later.record.find((h) => h.status !== 'completed')?.member, 'c', 'the earliest hop that did not complete is the failing member');
  assert.ok(!later.record.some((h) => h.reason?.layer === 'routing'));
});

test('a route whose router failed runs the fallback, else fails in the routing layer', async () => {
  const broken = (): RouteDecision => ({ reason: 'router down', failed: true });
  const withFallback = fakeScope(echo, { route: broken });
  assert.equal((await run({ kind: 'route', candidates: ['a'], fallback: 'triage' }, withFallback.scope)).output, 'triage(in)');
  const none = fakeScope(echo, { route: broken });
  const result = await run({ kind: 'route', candidates: ['a'] }, none.scope);
  assert.deepEqual(result, { status: 'failed', output: '', reason: { code: 'error', layer: 'routing', detail: 'router down' } });
  assert.equal(none.calls.length, 0);
});

test('a handoff whose router failed stops failed in the routing layer, with the usage of its turns', async () => {
  const { scope, calls, routes } = fakeScope((m, input) => ok(`${m}(${typeof input === 'string' ? input : input.text})`, { usage: { inputTokens: 3, outputTokens: 1 } }), {
    route: () => ({ reason: 'registry unavailable', failed: true }),
  });
  const result = await run({ kind: 'handoff', start: 'a', members: ['a', 'b'], router: 'router' }, scope);
  assert.deepEqual(result, { status: 'failed', output: '', reason: { code: 'error', layer: 'routing', detail: 'registry unavailable' }, usage: { inputTokens: 3, outputTokens: 1 } });
  assert.deepEqual(calls.map((c) => c.member), ['a']);
  assert.equal(routes[0]?.optional, true);
});

test('a handoff whose router throws writes a failed routing hop and the run fails in routing', async () => {
  const handoff: TopologySpec = { kind: 'handoff', start: 'a', members: ['a', 'b'], router: 'router' };
  const res = await (await assembled(handoff, () => { throw new Error('router down'); })).run('in');
  assert.deepEqual([res.status, res.reason?.code, res.reason?.layer], ['failed', 'error', 'routing']);
  assert.deepEqual(res.record.map((h) => [h.member, h.status, h.reason?.code, h.reason?.layer]), [['a', 'completed', undefined, undefined], ['', 'failed', 'error', 'routing']]);
});

test('graph: a waiting result follows only an edge whose condition names waiting; otherwise the graph waits', async () => {
  const waits = (m: string): MemberResult => (m === 'a' ? { status: 'waiting', output: '', reason: { code: 'needs_input', layer: 'member' } } : ok(m));
  const matchesAll: Condition = { matches: '' };
  const unnamed = fakeScope(waits);
  unnamed.scope.matches = () => true;
  const held = await run({ kind: 'graph', start: 'a', nodes: { a: 'a', b: 'b' }, edges: [{ from: 'a', to: 'b', when: matchesAll }], end: ['b'] }, unnamed.scope);
  assert.equal(held.status, 'waiting');
  assert.deepEqual(unnamed.calls.map((c) => c.member), ['a']);

  for (const status of ['waiting', ['failed', 'waiting']] as const) {
    const named = fakeScope(waits);
    named.scope.matches = () => true;
    const moved = await run({ kind: 'graph', start: 'a', nodes: { a: 'a', b: 'b' }, edges: [{ from: 'a', to: 'b', when: { status: status as Condition['status'] } }], end: ['b'] }, named.scope);
    assert.equal(moved.status, 'completed');
    assert.deepEqual(named.calls.map((c) => c.member), ['a', 'b']);
  }
});

// supervise -----------------------------------------------------------------------------------------------------------

/**
 * A supervisor that follows a script: on each of its turns it delegates to the next entry (a member id, or a member id
 * and an input), and once the script is done it completes with what it was last told. Other members echo.
 */
function supervisor(script: (string | { member: string; input?: unknown })[], extra: Partial<MemberResult> = {}): Reply {
  let turn = 0;
  return (member, input, options) => {
    const text = typeof input === 'string' ? input : input.text;
    if (member !== 'sup') return ok(`${member}(${text})`, extra);
    const next = script[turn++];
    if (next === undefined) return ok(`done: ${text}`, extra);
    const delegate = typeof next === 'string' ? { member: next } : next;
    return ok(`plan ${turn} at ${options.node}`, { ...extra, ext: { 'plexus.delegate': delegate } });
  };
}

const SUPERVISE: TopologySpec = { kind: 'supervise', supervisor: 'sup', members: ['a', 'b'] };

test('supervise: a supervisor that does not delegate is the node result', async () => {
  const { scope, calls } = fakeScope(supervisor([]));
  const result = await run(SUPERVISE, scope);
  assert.deepEqual(result, { status: 'completed', output: 'done: in' });
  assert.deepEqual(calls.map((c) => [c.member, c.options.node]), [['sup', 'root.supervisor[0]']]);
});

test('supervise: one delegation calls the member with the supervisor output, then reports the turn back', async () => {
  const { scope, calls } = fakeScope(supervisor(['a']));
  const result = await run(SUPERVISE, scope);
  assert.deepEqual(calls.map((c) => [c.member, c.options.node, c.input]), [
    ['sup', 'root.supervisor[0]', 'in'],
    ['a', 'root.members[0]', 'plan 1 at root.supervisor[0]'],
    ['sup', 'root.supervisor[1]', '[a]\na(plan 1 at root.supervisor[0])'],
  ]);
  assert.deepEqual(result, { status: 'completed', output: 'done: [a]\na(plan 1 at root.supervisor[0])' });
});

test('supervise: two delegations, the second with an input of its own; usage and cost of every call are summed', async () => {
  const { scope, calls } = fakeScope(supervisor(['a', { member: 'b', input: { text: 'look up order 7' } }], { usage: { inputTokens: 2, outputTokens: 1 }, costUsd: 0.25 }));
  const result = await run(SUPERVISE, scope);
  assert.deepEqual(calls.map((c) => [c.member, c.options.node]), [
    ['sup', 'root.supervisor[0]'], ['a', 'root.members[0]'], ['sup', 'root.supervisor[1]'], ['b', 'root.members[1]'], ['sup', 'root.supervisor[2]'],
  ]);
  assert.deepEqual(calls[3]?.input, { text: 'look up order 7' });
  assert.equal(calls[4]?.input, '[b]\nb(look up order 7)');
  assert.equal(result.output, 'done: [b]\nb(look up order 7)');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
  assert.equal(result.costUsd, 1.25);
});

test('supervise: a delegation outside members, or malformed, stops rejected in the topology layer', async () => {
  for (const [delegate, named] of [[{ member: 'z' }, '"z"'], ['a', '"undefined"'], [{ member: 'a', input: 7 }, 'input']] as const) {
    const { scope, calls } = fakeScope((member) => (member === 'sup' ? ok('plan', { ext: { 'plexus.delegate': delegate }, usage: { inputTokens: 1, outputTokens: 1 } }) : ok(member)));
    const result = await run(SUPERVISE, scope);
    assert.deepEqual([result.status, result.reason?.code, result.reason?.layer], ['stopped', 'rejected', 'topology']);
    assert.match(result.reason?.detail ?? '', new RegExp(named));
    assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 1 });
    assert.deepEqual(calls.map((c) => c.member), ['sup']);
  }
});

test('supervise: delegations are bounded by limits.system.maxHandoffs', async () => {
  const { scope, calls } = fakeScope(supervisor(['a', 'b', 'a', 'b']), { limits: { maxHandoffs: 2 } });
  const result = await run(SUPERVISE, scope);
  assert.deepEqual([result.status, result.reason?.code, result.reason?.layer, result.reason?.by], ['stopped', 'limit', 'topology', 'limits.system.maxHandoffs']);
  assert.equal(result.output, 'plan 3 at root.supervisor[2]');
  assert.deepEqual(calls.map((c) => c.member), ['sup', 'a', 'sup', 'b', 'sup']);
});

test('supervise: a result that is not completed, from the supervisor or a member, ends the node with it', async () => {
  const fromMember = fakeScope((member) => (member === 'sup' ? ok('plan', { ext: { 'plexus.delegate': { member: 'a' } } }) : failed('a broke')));
  assert.deepEqual(await run(SUPERVISE, fromMember.scope), { status: 'failed', output: 'a broke', reason: { code: 'error' } });
  assert.deepEqual(fromMember.calls.map((c) => c.member), ['sup', 'a']);

  const fromSupervisor = fakeScope(() => failed('sup broke'));
  assert.equal((await run(SUPERVISE, fromSupervisor.scope)).output, 'sup broke');
  assert.equal(fromSupervisor.calls.length, 1);
});

test('supervise: a waiting member or supervisor passes the wait through', async () => {
  const waiting = (member: string): MemberResult => ({ status: 'waiting', output: '', reason: { code: 'needs_input' }, wait: { token: `call:${member}:0#0`, kind: 'input', member } });
  const member = fakeScope((m) => (m === 'sup' ? ok('plan', { ext: { 'plexus.delegate': { member: 'b' } } }) : waiting(m)));
  const fromMember = await run(SUPERVISE, member.scope);
  assert.equal(fromMember.status, 'waiting');
  assert.deepEqual(fromMember.wait, { token: 'call:b:0#0', kind: 'input', member: 'b' });

  const sup = fakeScope((m) => waiting(m));
  assert.deepEqual((await run(SUPERVISE, sup.scope)).wait, { token: 'call:sup:0#0', kind: 'input', member: 'sup' });
});

test('supervise: node paths are unique per call and the same on a replay, so a journal replays every call', async () => {
  const nested: TopologySpec = { kind: 'sequence', steps: ['a', SUPERVISE] };
  const live = supervisor(['a', 'b', 'a']);
  const journal = new Map<string, MemberResult>();
  const first = fakeScope(async (member, input, options, n) => {
    const result = await live(member, input, options, n);
    journal.set(options.node, result);
    return result;
  });
  const original = await run(nested, first.scope);
  const paths = first.calls.map((c) => c.options.node);
  assert.equal(new Set(paths).size, paths.length, 'one path per call');

  // A replay answers each call from what was stored under its path: the walk asks for exactly the same calls.
  const replay = fakeScope((_member, _input, options) => {
    const hit = journal.get(options.node);
    assert.ok(hit, `a stored call for ${options.node}`);
    return hit;
  });
  const replayed = await run(nested, replay.scope);
  assert.deepEqual(replay.calls.map((c) => [c.member, c.options.node, c.input]), first.calls.map((c) => [c.member, c.options.node, c.input]));
  assert.deepEqual(replayed, original);
});

test('the bare handoff and delegate keys of 0.1.0 are still read (deprecated); the plexus. keys win over them', async () => {
  const handed = fakeScope((member) => (member === 'a' ? ok('from a', { ext: { handoff: 'b' } }) : ok(`from ${member}`)));
  assert.equal((await run({ kind: 'handoff', start: 'a', members: ['a', 'b', 'c'] }, handed.scope)).output, 'from b');
  const both = fakeScope((member) => (member === 'a' ? ok('from a', { ext: { 'plexus.handoff': 'c', handoff: 'b' } }) : ok(`from ${member}`)));
  assert.equal((await run({ kind: 'handoff', start: 'a', members: ['a', 'b', 'c'] }, both.scope)).output, 'from c');
  let turn = 0;
  const delegated = fakeScope((member) => (member === 'sup' && turn++ === 0 ? ok('plan', { ext: { delegate: { member: 'a' } } }) : ok(`${member} done`)));
  assert.deepEqual((await run(SUPERVISE, delegated.scope)).output, 'sup done');
  assert.deepEqual(delegated.calls.map((c) => c.member), ['sup', 'a', 'sup']);
});
