import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions, Condition, MemberResult, RouteDecision, RouteRequest, RunInput, RunScope, TopologyLimits, TopologySpec,
} from '@agent-plexus/core';
import { adapter, createBasicTopology } from '../src/index.ts';

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
  assert.deepEqual([...createBasicTopology().kinds], ['sequence', 'route', 'loop', 'parallel']);
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
  assert.throws(() => topology.bind({ kind: 'handoff', start: 'a', members: ['a'] }, info), /handoff/);
  assert.throws(() => topology.bind({ kind: 'supervise', supervisor: 's', members: ['a'] }, info), /supervise/);
  assert.throws(() => topology.bind({ kind: 'graph', nodes: {}, start: 'a', edges: [], end: [] }, info), /graph/);
  assert.throws(
    () => topology.bind({ kind: 'sequence', steps: ['a', { kind: 'handoff', start: 'a', members: ['a'] }] }, info),
    /root\.steps\[1\].*handoff/,
  );
});

test('malformed specs are rejected at bind', () => {
  const topology = createBasicTopology();
  const info = { system: 'test', members: [] };
  assert.throws(() => topology.bind({ kind: 'sequence', steps: [] }, info), /steps/);
  assert.throws(() => topology.bind({ kind: 'loop', body: 'a', until: {}, maxIterations: 0 }, info), /maxIterations/);
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
