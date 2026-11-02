import { isDeepStrictEqual } from 'node:util';
import type { MemberResult, RouteDecision, TopologyKind, TopologyNode, TopologyPort, TopologySpec, WaitRef } from '@agent-plexus/core';
import { Checks, describeError, settle, sleep } from '../check.ts';
import { completed, fakeScope, untilAborted, type FakeScope, type FakeScopeOptions } from '../fake-scope.ts';
import { resultProblems } from '../shapes.ts';

export const TOPOLOGY_KINDS: readonly TopologyKind[] = ['sequence', 'parallel', 'route', 'loop', 'handoff', 'supervise', 'graph'];

export interface TopologyFixtures {
  /** The kinds to check; default: every kind the adapter lists in `kinds`. */
  kinds?: TopologyKind[];
}

const WAIT: WaitRef = { token: 'call:root:0#0', kind: 'input', member: 'w' };
const waiting = (): MemberResult => ({ status: 'waiting', output: 'need more', reason: { code: 'needs_input', layer: 'member' }, taskRef: 'task-w', wait: { ...WAIT } });

/** A small spec of each kind, on members a, b and c. */
const MINIMAL: Record<TopologyKind, TopologySpec> = {
  sequence: { kind: 'sequence', steps: ['a', 'b'] },
  parallel: { kind: 'parallel', branches: ['a', 'b'] },
  route: { kind: 'route', candidates: ['a', 'b'] },
  loop: { kind: 'loop', body: 'a', until: { status: 'completed' } },
  handoff: { kind: 'handoff', start: 'a', members: ['a', 'b'] },
  supervise: { kind: 'supervise', supervisor: 'a', members: ['b'] },
  graph: { kind: 'graph', nodes: { x: 'a', y: 'b' }, start: 'x', edges: [{ from: 'x', to: 'y' }], end: ['y'] },
};

/** A spec of each kind whose run reaches the waiting member `w` and ends there. */
const WAITING: Record<TopologyKind, TopologySpec> = {
  sequence: { kind: 'sequence', steps: ['a', 'w'] },
  parallel: { kind: 'parallel', branches: ['a', 'w'] },
  route: { kind: 'route', candidates: ['w', 'a'] },
  loop: { kind: 'loop', body: 'w', until: { status: 'completed' } },
  handoff: { kind: 'handoff', start: 'w', members: ['w', 'a'] },
  supervise: { kind: 'supervise', supervisor: 'w', members: ['a'] },
  graph: { kind: 'graph', nodes: { x: 'w', y: 'a' }, start: 'x', edges: [{ from: 'x', to: 'y' }], end: ['y'] },
};

/** Member ids a spec names. */
function membersOf(node: TopologyNode, out = new Set<string>()): string[] {
  if (typeof node === 'string') {
    out.add(node);
    return [...out];
  }
  switch (node.kind) {
    case 'sequence': node.steps.forEach((n) => membersOf(n, out)); break;
    case 'parallel': node.branches.forEach((n) => membersOf(n, out)); if (node.merge !== undefined) membersOf(node.merge, out); break;
    case 'route': if (Array.isArray(node.candidates)) node.candidates.forEach((m) => out.add(m)); if (node.fallback !== undefined) membersOf(node.fallback, out); break;
    case 'loop': membersOf(node.body, out); break;
    case 'handoff': out.add(node.start); node.members.forEach((m) => out.add(m)); break;
    case 'supervise': out.add(node.supervisor); node.members.forEach((m) => out.add(m)); break;
    case 'graph': Object.values(node.nodes).forEach((n) => membersOf(n, out)); break;
  }
  return [...out];
}

interface Outcome { result: MemberResult; scope: FakeScope }

/**
 * Binds and runs a spec on a fake scope, then applies the rules every run must keep: members only through
 * `scope.call` with a node path (T2), shares of concurrent calls (T8) and a valid result (T9).
 */
async function run(port: TopologyPort, c: Checks, rule: string, label: string, spec: TopologySpec, options: FakeScopeOptions = {}, extraMembers: string[] = []): Promise<Outcome | undefined> {
  const members = [...membersOf(spec), ...extraMembers];
  const bound = await c.attempt(rule, `${label}: bind`, () => port.bind(structuredClone(spec), { system: 'conformance', members }));
  if (!bound) return undefined;
  const scope = fakeScope(options);
  const result = await c.attempt(rule, `${label}: run`, () => bound.run(scope.input, scope));
  for (const call of scope.calls) {
    c.expect('T2', members.includes(call.member), `${label}: called "${call.member}", which the spec does not name`);
    c.expect('T2', typeof call.options?.node === 'string' && call.options.node.length > 0, `${label}: scope.call of "${call.member}" must pass a node path`);
    if (call.concurrentShares.length > 1) {
      const shares = call.concurrentShares;
      c.expect('T8', shares.every((s) => typeof s === 'number' && s > 0), `${label}: calls that run at the same time must each pass a share`);
      const sum = shares.reduce<number>((t, s) => t + (s ?? 0), 0);
      c.expect('T8', sum <= 1 + 1e-9, `${label}: shares of calls running at the same time sum to ${sum}, more than 1`);
    }
  }
  for (const request of scope.routes) c.expect('T2', typeof request.node === 'string' && request.node.length > 0, `${label}: scope.route must pass a node path`);
  if (result === undefined) return undefined;
  c.all('T9', resultProblems(result), `${label}: result`);
  return { result, scope };
}

const paths = (o: Outcome | undefined): string[] => (o ? o.scope.calls.map((call) => call.options.node) : []);
const keys = (o: Outcome | undefined): string[] => (o ? o.scope.calls.map((call) => `${call.options.node}|${call.member}|${call.input}`).sort() : []);

/** Runs the TopologyPort rules T1-T9 against an instance, on fake members through a fake RunScope. */
export async function checkTopology(port: TopologyPort, f: TopologyFixtures = {}, c = new Checks()): Promise<Checks> {
  const declared = Array.isArray(port?.kinds) ? port.kinds : [];
  c.expect('T1', declared.length > 0, 'kinds must list at least one kind');
  c.expect('T1', declared.every((k) => TOPOLOGY_KINDS.includes(k)), `kinds lists an unknown kind: ${declared.join(', ')}`);
  c.expect('T1', new Set(declared).size === declared.length, 'kinds must not repeat a kind');
  if (typeof port?.bind !== 'function') {
    c.fail('T1', 'bind must be a function');
    return c;
  }
  const kinds: TopologyKind[] = (f.kinds ?? declared).filter((k) => declared.includes(k));
  const has = (k: TopologyKind) => kinds.includes(k);

  await refusals(port, declared, c);
  for (const kind of kinds) await run(port, c, 'T1', `${kind}: minimal spec`, MINIMAL[kind]);
  await nodePaths(port, has, c);
  await shuffled(port, has, c);
  await passthrough(port, kinds, c);
  await routing(port, has, c);
  await bounds(port, has, c);
  await parallel(port, has, c);
  await original(port, has, c);
  return c;
}

/** T1: bind rejects a kind it does not run, naming the kind and its path. */
async function refusals(port: TopologyPort, declared: readonly TopologyKind[], c: Checks): Promise<void> {
  const unsupported: { kind: string; node: TopologySpec }[] = TOPOLOGY_KINDS.filter((k) => !declared.includes(k)).map((k) => ({ kind: k, node: MINIMAL[k] }));
  unsupported.push({ kind: 'conformance-unknown', node: { kind: 'conformance-unknown' } as unknown as TopologySpec });
  const nest = declared.includes('sequence');
  for (const { kind, node } of unsupported) {
    const spec: TopologySpec = nest ? { kind: 'sequence', steps: ['a', node] } : node;
    const path = nest ? 'root.steps[1]' : 'root';
    const out = await settle(() => port.bind(spec, { system: 'conformance', members: membersOf(spec) }), c.timeoutMs);
    if (!('error' in out)) {
      c.fail('T1', `bind must reject a spec with kind "${kind}" at ${path}`);
      continue;
    }
    const message = describeError(out.error);
    c.expect('T1', message.includes(kind) && message.includes(path), `bind refused kind "${kind}" without naming it and its path ${path}: ${message}`);
  }
}

/** T3: node paths follow the documented forms, differ between call sites and are the same on every run. */
async function nodePaths(port: TopologyPort, has: (k: TopologyKind) => boolean, c: Checks): Promise<void> {
  const documented: { kind: TopologyKind; spec: TopologySpec; options?: FakeScopeOptions; expect: string[] }[] = [
    { kind: 'sequence', spec: { kind: 'sequence', steps: ['a', 'b'] }, expect: ['root.steps[0]', 'root.steps[1]'] },
    { kind: 'parallel', spec: { kind: 'parallel', branches: ['a', 'b'] }, expect: ['root.branches[0]', 'root.branches[1]'] },
    { kind: 'route', spec: { kind: 'route', candidates: ['a', 'b'] }, expect: ['root'] },
    { kind: 'route', spec: { kind: 'route', candidates: ['a'], fallback: 'b' }, options: { route: () => ({}) }, expect: ['root.fallback'] },
    { kind: 'loop', spec: { kind: 'loop', body: 'a', until: { matches: '^never$' }, maxIterations: 2 }, expect: ['root.body#1', 'root.body#2'] },
    {
      kind: 'handoff',
      spec: { kind: 'handoff', start: 'a', members: ['a', 'b'], router: 'router' },
      options: { route: (_r, n) => (n === 0 ? { member: 'b' } : {}) },
      expect: ['root.turns[0]', 'root.turns[1]'],
    },
    {
      kind: 'graph',
      spec: { kind: 'graph', nodes: { x: 'a', y: 'b' }, start: 'x', edges: [{ from: 'x', to: 'y' }, { from: 'y', to: 'x', when: { matches: '^again$' } }], end: ['y'] },
      options: { members: { b: (_i, _o, n) => completed(n === 0 ? 'again' : 'done') } },
      expect: ['root.nodes.x', 'root.nodes.y', 'root.nodes.x#2', 'root.nodes.y#2'],
    },
  ];
  for (const { kind, spec, options, expect } of documented) {
    if (!has(kind)) continue;
    const first = await run(port, c, 'T3', `${kind}: node paths`, spec, options);
    if (!first) continue;
    const got = paths(first);
    const sorted = kind === 'parallel' ? [...got].sort() : got;
    c.expect('T3', isDeepStrictEqual(sorted, expect), `${kind}: node paths ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`);
    const second = await run(port, c, 'T3', `${kind}: node paths again`, spec, options);
    c.expect('T3', isDeepStrictEqual(keys(first), keys(second)), `${kind}: node paths must be the same on every run`);
  }

  // One member at several call sites: each site has a path of its own.
  const sites: { kind: TopologyKind[]; spec: TopologySpec; count: number }[] = [
    { kind: ['sequence'], spec: { kind: 'sequence', steps: ['a', 'a', 'a'] }, count: 3 },
    { kind: ['parallel'], spec: { kind: 'parallel', branches: ['a', 'a'] }, count: 2 },
    { kind: ['graph'], spec: { kind: 'graph', nodes: { x: 'a', y: 'a' }, start: 'x', edges: [{ from: 'x', to: 'y' }], end: ['y'] }, count: 2 },
    { kind: ['sequence', 'parallel'], spec: { kind: 'sequence', steps: [{ kind: 'parallel', branches: ['a', 'a'] }, { kind: 'parallel', branches: ['a', 'a'] }] }, count: 4 },
    { kind: ['sequence', 'route'], spec: { kind: 'sequence', steps: [{ kind: 'route', candidates: ['a'] }, { kind: 'route', candidates: ['a'] }] }, count: 2 },
    { kind: ['parallel', 'loop'], spec: { kind: 'parallel', branches: [{ kind: 'loop', body: 'a', until: { status: 'completed' } }, { kind: 'loop', body: 'a', until: { status: 'completed' } }] }, count: 2 },
  ];
  for (const { kind, spec, count } of sites) {
    if (!kind.every(has)) continue;
    const label = `${kind.join(' + ')}: one member at ${count} call sites`;
    const out = await run(port, c, 'T3', label, spec);
    if (!out) continue;
    const got = paths(out);
    c.expect('T3', got.length === count && new Set(got).size === count, `${label}: each call site needs a node path of its own, got ${JSON.stringify(got)}`);
    c.expect('T3', got.every((p) => p === 'root' || p.startsWith('root.')), `${label}: node paths must start at root, got ${JSON.stringify(got)}`);
  }
}

/** T4: branches that finish in another order give the same result and the same calls. */
async function shuffled(port: TopologyPort, has: (k: TopologyKind) => boolean, c: Checks): Promise<void> {
  if (!has('parallel')) return c.skip('T4', 'replay with shuffled branch completion: the adapter does not run parallel');
  const branches: TopologyNode[] = has('sequence') ? ['a', 'b', { kind: 'sequence', steps: ['c', 'a'] }] : ['a', 'b', 'c'];
  const spec: TopologySpec = { kind: 'parallel', branches };
  const orders = [[1, 10, 20], [20, 10, 1], [10, 20, 1], [1, 20, 10]];
  let reference: { result: MemberResult; keys: string[] } | undefined;
  for (const delays of orders) {
    const delay = (name: string, ms: number) => async (input: unknown) => { await sleep(ms); return completed(`${name}(${String(input)})`); };
    const members = { a: delay('a', delays[0]!), b: delay('b', delays[1]!), c: delay('c', delays[2]!) };
    const out = await run(port, c, 'T4', `parallel finishing in order ${delays.join('/')}`, spec, { members });
    if (!out) continue;
    const now = { result: { status: out.result.status, output: out.result.output } as MemberResult, keys: keys(out) };
    if (!reference) reference = now;
    else {
      c.expect('T4', isDeepStrictEqual(now.result, reference.result), `parallel: the result depends on the order the branches finish (${JSON.stringify(now.result)} vs ${JSON.stringify(reference.result)})`);
      c.expect('T4', isDeepStrictEqual(now.keys, reference.keys), 'parallel: the node paths of the calls depend on the order the branches finish');
    }
  }
}

/** T5: a waiting result passes through every supported kind with its `wait` unchanged. */
async function passthrough(port: TopologyPort, kinds: readonly TopologyKind[], c: Checks): Promise<void> {
  for (const kind of kinds) {
    const out = await run(port, c, 'T5', `${kind}: a member waits`, WAITING[kind], { members: { w: waiting } });
    if (!out) continue;
    const { result } = out;
    c.expect('T5', result.status === 'waiting' && result.reason?.code === 'needs_input', `${kind}: a member that waits must end the topology waiting with its reason, got ${result.status}/${result.reason?.code}`);
    c.expect('T5', isDeepStrictEqual(result.wait, WAIT), `${kind}: the waiting result must keep the member's wait unchanged, got ${JSON.stringify(result.wait)}`);
  }
}

/** T6: route and handoff semantics, failed decisions and `optional`. */
async function routing(port: TopologyPort, has: (k: TopologyKind) => boolean, c: Checks): Promise<void> {
  if (has('route')) {
    const ranked = [{ member: 'b', score: 1 }, { member: 'a', score: 0 }];
    const chosen = await run(port, c, 'T6', 'route: router chooses b', { kind: 'route', candidates: ['a', 'b'] }, { route: () => ({ member: 'b', ranked }) });
    if (chosen) {
      const [call] = chosen.scope.calls;
      const [request] = chosen.scope.routes;
      c.expect('T6', chosen.scope.calls.length === 1 && call?.member === 'b', 'route: must call the member the router chose, once');
      c.expect('T6', call?.options.route?.member === 'b', 'route: the call must carry the router decision (CallOptions.route)');
      c.expect('T6', chosen.result.output === 'b(hello)', 'route: the result must be the chosen member\'s');
      c.expect('T6', isDeepStrictEqual(request?.candidates, ['a', 'b']) && !request?.optional, 'route: must ask the router with the node\'s candidates and without optional');
    }
    const failed: RouteDecision = { failed: true, reason: 'router down' };
    const noFallback = await run(port, c, 'T6', 'route: decision failed, no fallback', { kind: 'route', candidates: ['a'] }, { route: () => failed });
    if (noFallback) {
      const r = noFallback.result;
      c.expect('T6', r.status === 'failed' && r.reason?.code === 'error' && r.reason.layer === 'routing' && noFallback.scope.calls.length === 0, `route: a failed decision without fallback must end failed, code error, layer routing (got ${r.status}/${r.reason?.code}/${r.reason?.layer})`);
    }
    const withFallback = await run(port, c, 'T6', 'route: decision failed, fallback', { kind: 'route', candidates: ['a'], fallback: 'c' }, { route: () => failed });
    if (withFallback) c.expect('T6', withFallback.scope.calls.map((x) => x.member).join() === 'c', 'route: a failed decision must run the fallback');
    const nobody = await run(port, c, 'T6', 'route: nobody chosen, no fallback', { kind: 'route', candidates: ['a'] }, { route: () => ({}) });
    if (nobody) {
      const r = nobody.result;
      c.expect('T6', r.status === 'stopped' && r.reason?.code === 'rejected' && nobody.scope.calls.length === 0, `route: choosing nobody without fallback must stop with code rejected (got ${r.status}/${r.reason?.code})`);
    }
    const nobodyFallback = await run(port, c, 'T6', 'route: nobody chosen, fallback', { kind: 'route', candidates: ['a'], fallback: 'c' }, { route: () => ({}) });
    if (nobodyFallback) c.expect('T6', nobodyFallback.scope.calls.map((x) => x.member).join() === 'c', 'route: choosing nobody must run the fallback');
  } else c.skip('T6', 'route semantics: the adapter does not run route');

  if (has('handoff')) {
    const spec: TopologySpec = { kind: 'handoff', start: 'a', members: ['a', 'b'], router: 'router' };
    const ends = await run(port, c, 'T6', 'handoff: router hands to b, then to nobody', spec, { route: (_r, n) => (n === 0 ? { member: 'b' } : {}) });
    if (ends) {
      c.expect('T6', ends.scope.calls.map((x) => x.member).join() === 'a,b', `handoff: must call a, then the member the router chose (called ${ends.scope.calls.map((x) => x.member).join()})`);
      c.expect('T6', ends.scope.routes.length > 0 && ends.scope.routes.every((r) => r.optional === true), 'handoff: must ask its router with optional: true');
      c.expect('T6', ends.scope.routes.every((r) => r.router === 'router'), 'handoff: must ask the router the node names');
      c.expect('T6', ends.result.status === 'completed' && ends.result.output === 'b(a(hello))', 'handoff: a router that chooses nobody must end the handoff completed with the last answer');
    }
    const failed = await run(port, c, 'T6', 'handoff: decision failed', spec, { route: () => ({ failed: true, reason: 'router down' }) });
    if (failed) {
      const r = failed.result;
      c.expect('T6', r.status === 'failed' && r.reason?.code === 'error' && r.reason.layer === 'routing', `handoff: a failed decision must end failed, code error, layer routing (got ${r.status}/${r.reason?.code}/${r.reason?.layer})`);
    }
  } else c.skip('T6', 'handoff semantics: the adapter does not run handoff');
}

/** T7: loops, handoffs and graphs stay within their bounds and stop with code limit. */
async function bounds(port: TopologyPort, has: (k: TopologyKind) => boolean, c: Checks): Promise<void> {
  const limited = (r: MemberResult | undefined) => r?.status === 'stopped' && r.reason?.code === 'limit';
  if (has('loop')) {
    const never = { matches: '^never$' };
    const scoped = await run(port, c, 'T7', 'loop: until never holds', { kind: 'loop', body: 'a', until: never }, { limits: { maxIterations: 3 } });
    if (scoped) c.expect('T7', scoped.scope.calls.length === 3 && limited(scoped.result), `loop: must stop with code limit after scope.limits.maxIterations (3) iterations, made ${scoped.scope.calls.length} calls, ended ${scoped.result.status}/${scoped.result.reason?.code}`);
    const own = await run(port, c, 'T7', 'loop: own maxIterations', { kind: 'loop', body: 'a', until: never, maxIterations: 2 }, { limits: { maxIterations: 5 } });
    if (own) c.expect('T7', own.scope.calls.length === 2 && limited(own.result), `loop: must stop with code limit after its own maxIterations (2), made ${own.scope.calls.length} calls`);
  }
  if (has('handoff')) {
    const alternate = (_r: unknown, n: number) => ({ member: n % 2 === 0 ? 'b' : 'a' });
    for (const [label, spec, max] of [
      ['scope.limits.maxHandoffs (2)', { kind: 'handoff', start: 'a', members: ['a', 'b'], router: 'router' }, 2],
      ['its own maxHandoffs (1)', { kind: 'handoff', start: 'a', members: ['a', 'b'], router: 'router', maxHandoffs: 1 }, 1],
    ] as [string, TopologySpec, number][]) {
      const out = await run(port, c, 'T7', `handoff: bounded by ${label}`, spec, { route: alternate, limits: { maxHandoffs: 2 } });
      if (out) c.expect('T7', out.scope.calls.length <= max + 1 && limited(out.result), `handoff: must stop with code limit within ${label}, made ${out.scope.calls.length} calls, ended ${out.result.status}/${out.result.reason?.code}`);
    }
  }
  if (has('graph')) {
    const spec: TopologySpec = { kind: 'graph', nodes: { x: 'a' }, start: 'x', edges: [{ from: 'x', to: 'x' }], end: [] };
    const out = await run(port, c, 'T7', 'graph: a node that loops on itself', spec, { limits: { maxIterations: 3 } });
    if (out) c.expect('T7', out.scope.calls.length <= 3 && limited(out.result), `graph: a node visited more than maxIterations (3) times must stop with code limit, made ${out.scope.calls.length} calls`);
  }
}

/** T8: parallel branches pass shares that sum to at most 1; `join: first` aborts and abandons the others. */
async function parallel(port: TopologyPort, has: (k: TopologyKind) => boolean, c: Checks): Promise<void> {
  if (!has('parallel')) return c.skip('T8', 'parallel: the adapter does not run parallel');
  const slow = async (input: unknown) => { await sleep(20); return completed(String(input)); };
  const nested: TopologySpec = { kind: 'parallel', branches: ['a', { kind: 'parallel', branches: ['b', 'c'] }, 'd'] };
  const out = await run(port, c, 'T8', 'parallel: nested branches at once', nested, { members: { a: slow, b: slow, c: slow, d: slow }, limits: { maxParallel: 8 } });
  if (out) c.expect('T8', out.scope.maxInFlight > 1, 'parallel: branches must run at the same time');

  const fast = async () => { await sleep(20); return completed('fast'); };
  const first: TopologySpec = { kind: 'parallel', branches: ['f', 's1', 's2'], join: 'first' };
  const started = Date.now();
  const raced = await run(port, c, 'T8', 'parallel join first', first, { members: { f: fast, s1: untilAborted, s2: untilAborted }, limits: { maxParallel: 4 } });
  if (!raced) return;
  c.expect('T8', raced.result.status === 'completed' && raced.result.output === 'fast', `parallel join first: must return the first completed branch, got ${raced.result.status} "${raced.result.output}"`);
  const losers = raced.scope.calls.filter((x) => x.member !== 'f');
  c.expect('T8', losers.every((x) => x.options.signal?.aborted === true), 'parallel join first: must abort the branches still running');
  c.expect('T8', losers.every((x) => raced.scope.abandoned.includes(x.hopId)), `parallel join first: must abandon the hops of the aborted branches (abandoned ${JSON.stringify(raced.scope.abandoned)})`);
  c.expect('T8', !raced.scope.abandoned.some((h) => raced.scope.calls.find((x) => x.hopId === h)?.member === 'f'), 'parallel join first: must not abandon the winning branch');
  c.expect('T8', Date.now() - started < 3000, 'parallel join first: must return promptly once a branch completed');
}

/** T9: results are valid (checked on every run); `input: "original"` gives a node the system's input. */
async function original(port: TopologyPort, has: (k: TopologyKind) => boolean, c: Checks): Promise<void> {
  if (!has('sequence')) return c.skip('T9', 'input original: the adapter does not run sequence');
  const spec: TopologySpec = { kind: 'sequence', steps: ['a', { kind: 'sequence', input: 'original', steps: ['b'] }] };
  const out = await run(port, c, 'T9', 'sequence: input original', spec, { input: 'first words' });
  if (out) c.expect('T9', out.scope.calls[1]?.input === 'first words', `input "original" must give the node the system's input, got "${out.scope.calls[1]?.input}"`);
}
