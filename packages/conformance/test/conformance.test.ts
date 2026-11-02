import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineAdapter, PORT_VERSIONS, prototypeHost, type Execution, type ExecutionPort, type Host, type MemberPort, type TopologyPort } from '@agent-plexus/core';
import {
  CANARY_CREDENTIAL, checkAdapter, checkAttribution, checkExecution, checkHost, checkMember, checkRegistry, checkRouter, checkSystem, checkTopology,
  conformance, extProblems, extWarnings, failuresExcept, failuresOf, fakeScope,
} from '../src/index.ts';
import { Checks, sleep } from '../src/check.ts';
import {
  attributionAdapter, executionAdapter, memberAdapter, referenceAttribution, referenceExecution, referenceMember, referenceRegistry, referenceRouter, referenceTopology, topologyAdapter,
} from './reference.ts';

const run = async <T>(suite: (impl: T, f: any, c: Checks) => Promise<Checks>, impl: T, f: unknown = {}) => suite(impl, f, new Checks({ timeoutMs: 2000 }));
const rulesOf = (c: Checks) => [...new Set(c.failures.map((f) => f.slice(0, f.indexOf(':'))))].sort();

/** An execution whose `begin` hands out executions with one operation replaced. */
function withExecution(patch: (e: Execution, port: ExecutionPort) => Partial<Execution>, portPatch: Partial<ExecutionPort> = {}): ExecutionPort {
  const port = referenceExecution();
  return { ...port, ...portPatch, async begin(key) { const e = await port.begin(key); return { ...e, ...patch(e, port) }; } };
}

test('every suite passes on the reference implementations', async () => {
  assert.deepEqual((await run(checkExecution, referenceExecution())).failures, []);
  assert.deepEqual((await run(checkTopology, referenceTopology())).failures, []);
  assert.deepEqual((await run(checkMember, referenceMember())).failures, []);
  assert.deepEqual((await run(checkRegistry, referenceRegistry())).failures, []);
  assert.deepEqual((await run(checkRouter, referenceRouter())).failures, []);
  assert.deepEqual((await run(checkAttribution, referenceAttribution())).failures, []);
  assert.deepEqual((await run(checkHost, prototypeHost({ quiet: true }))).failures, []);
});

test('execution: each defect fails its rule', async () => {
  const twice = withExecution((e) => ({ step: (name, fn) => fn() }));
  assert.ok(rulesOf(await run(checkExecution, twice)).includes('E1'));
  const keepsError = withExecution((e) => ({ step: (name, fn) => e.step(name, () => fn().catch(() => 'stored error' as never)) }));
  assert.ok(rulesOf(await run(checkExecution, keepsError)).includes('E3'));
  const alwaysTrue = withExecution(() => ({}), {});
  const base = referenceExecution();
  alwaysTrue.signal = async (key, name, value) => { await base.signal(key, name, value).catch(() => false); return true; };
  assert.ok(rulesOf(await run(checkExecution, alwaysTrue)).includes('E8'));
  const shared = new Map<string, unknown>();
  const byReference = withExecution(() => ({ remember: async (k, v) => { shared.set(k, v); }, recall: async (k) => shared.get(k) }));
  assert.ok(rulesOf(await run(checkExecution, byReference)).includes('E10'));
  const deaf = withExecution((e) => ({ wait: (name, untilAt) => (Date.parse(untilAt) < Date.now() ? Promise.resolve(undefined) : e.wait(name, untilAt)) }));
  assert.ok(rulesOf(await run(checkExecution, deaf)).includes('E7'));
  const exclusive = await run(checkExecution, referenceExecution(), { exclusive: true, secondInstance: () => referenceExecution() });
  assert.ok(rulesOf(exclusive).includes('E13'), 'an exclusive adapter needs release');
});

test('topology: each defect fails its rule', async () => {
  const ref = referenceTopology();
  const samePath: TopologyPort = { ...ref, bind: (spec, info) => {
    const bound = ref.bind(spec, info) as { run: (i: any, s: any) => any };
    return { run: (input, scope) => bound.run(input, { ...scope, call: (m: string, i: any, o: any) => scope.call(m, i, { ...o, node: 'root' }) }) };
  } };
  assert.ok(rulesOf(await run(checkTopology, samePath)).includes('T3'));
  const silentBind: TopologyPort = { ...ref, bind: (spec, info) => { try { return ref.bind(spec, info); } catch { return { run: async () => ({ status: 'completed', output: '' }) }; } } };
  assert.ok(rulesOf(await run(checkTopology, silentBind)).includes('T1'));
  const ignoresFailed: TopologyPort = { ...ref, bind: (spec, info) => {
    const bound = ref.bind(spec, info) as { run: (i: any, s: any) => any };
    return { run: (input, scope) => bound.run(input, { ...scope, route: async (r: any) => { const d = await scope.route(r); return d.failed ? {} : d; } }) };
  } };
  assert.ok(rulesOf(await run(checkTopology, ignoresFailed)).includes('T6'));
  const noKinds: TopologyPort = { ...ref, kinds: [] };
  assert.ok(rulesOf(await run(checkTopology, noKinds)).includes('T1'));
});

test('member: each defect fails its rule', async () => {
  const ref = referenceMember();
  const leaky: MemberPort = { ...ref, invoke: async (input, ctx) => ({ status: 'completed', output: `token ${ctx.credential}` }) };
  assert.ok(rulesOf(await run(checkMember, leaky)).includes('M4'));
  const deaf: MemberPort = { ...ref, invoke: async () => ({ status: 'completed', output: 'ignored the abort' }) };
  assert.ok(rulesOf(await run(checkMember, deaf)).includes('M3'));
  const bad: MemberPort = { ...ref, invoke: async () => ({ status: 'stopped', output: '', ext: { plain: 1 } } as never) };
  assert.ok(rulesOf(await run(checkMember, bad)).includes('M2'));
  const negative: MemberPort = { ...ref, invoke: async () => ({ status: 'completed', output: '', costUsd: -1 }) };
  assert.ok(rulesOf(await run(checkMember, negative)).includes('M8'));
  const waitsBadly: MemberPort = { ...ref, invoke: async () => ({ status: 'waiting', output: '', reason: { code: 'error' } }) };
  assert.ok(rulesOf(await run(checkMember, waitsBadly, { wait: 'x' })).includes('M6'));
  const checkpoints: MemberPort = { ...ref, invoke: async (input, ctx) => { await ctx.checkpoint(''); return { status: 'completed', output: '' }; } };
  assert.ok(rulesOf(await run(checkMember, checkpoints, { checkpoint: 'x' })).includes('M5'));
  const slow: MemberPort = { ...ref, invoke: async () => { await sleep(3000); return { status: 'completed', output: '' }; } };
  assert.ok(rulesOf(await run(checkMember, slow, { slow: 'x', promptMs: 200 })).includes('M3'));
});

test('member: a reason that claims a plexus layer or host fails M10; layer member or a memberLayer passes', async () => {
  const ref = referenceMember();
  const failing = (reason: Record<string, unknown>): MemberPort => ({ ...ref, invoke: async (_i, ctx) => (ctx.signal?.aborted ? { status: 'stopped', output: '', reason: { code: 'aborted', layer: 'member' } } : { status: 'failed', output: '', reason } as never) });
  for (const layer of ['host', 'topology', 'tools']) assert.ok(rulesOf(await run(checkMember, failing({ code: 'error', layer }))).includes('M10'), layer);
  assert.ok(!rulesOf(await run(checkMember, failing({ code: 'error', layer: 'member', memberLayer: 'tools' }))).includes('M10'));
  assert.ok(!rulesOf(await run(checkMember, failing({ code: 'error', memberLayer: 'host' }))).includes('M10'));
});

test('ext: the plexus.delegate and plexus.handoff protocol keys pass; the bare 0.1.0 keys are warnings, not failures', async () => {
  assert.deepEqual(extProblems({ 'plexus.delegate': { member: 'a' }, 'plexus.handoff': 'b', 'mine.x': 1 }), []);
  assert.deepEqual(extProblems({ 'plexus.other': 1 }), ['ext key "plexus.other" is in the core\'s plexus namespace']);
  assert.deepEqual(extProblems({ delegate: { member: 'a' }, handoff: 'b' }), []);
  assert.deepEqual(extProblems({ plain: 1 }), ['ext key "plain" is not namespaced as <adapter>.<name>']);
  assert.deepEqual(extWarnings({ delegate: {}, 'plexus.handoff': 'b' }), ['ext key "delegate" is deprecated: use "plexus.delegate"']);
  const ref = referenceMember();
  const bare: MemberPort = { ...ref, invoke: async (input, ctx) => (ctx.signal?.aborted ? ref.invoke(input, ctx) : { status: 'completed', output: 'plan', ext: { delegate: { member: 'a' } } }) };
  const c = await run(checkMember, bare);
  assert.deepEqual(c.failures, []);
  assert.ok(c.warnings.some((w) => w.startsWith('M2: ') && w.includes('"delegate" is deprecated')), c.warnings.join('\n'));
  const report = await conformance('MemberPort', bare);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.length > 0);
});

test('member: capabilities must match the instance (through checkAdapter)', async () => {
  const lying = defineAdapter({ ...memberAdapter, capabilities: { resume: true, cancel: false, checkpoint: false, waits: false } });
  assert.ok(failuresOf(await checkAdapter(lying), 'M9').length > 0);
  const silent = defineAdapter({ ...memberAdapter, capabilities: undefined });
  assert.ok(failuresOf(await checkAdapter(silent), 'M9').length > 0);
  assert.deepEqual((await checkAdapter(memberAdapter)).failures, []);
});

test('registry, router and attribution: each defect fails its rule', async () => {
  const ref = referenceRegistry();
  const anyTag = { ...ref, list: async (f?: { tags?: string[] }) => (await ref.list()).filter((e) => !f?.tags?.length || f.tags.some((t) => e.skills.some((s) => s.tags.includes(t)))) };
  assert.ok(rulesOf(await run(checkRegistry, anyTag)).includes('R3'));
  const stale = { ...ref, get: async () => undefined };
  assert.ok(rulesOf(await run(checkRegistry, stale)).includes('R2'));
  const untrusted = { ...ref, list: async () => (await ref.list()).map((e) => ({ ...e, trust: { signed: 'no' } })) } as never;
  assert.ok(rulesOf(await run(checkRegistry, untrusted)).includes('R4'));

  const router = referenceRouter();
  const sorts = { ...router, route: async (q: any, ctx: any) => { q.candidates.sort(); return router.route(q, ctx); } };
  assert.ok(rulesOf(await run(checkRouter, sorts)).includes('A3'));
  const peeks = { ...router, route: async (q: any, ctx: any) => { void q.caller?.credential; return router.route(q, ctx); } };
  assert.ok(rulesOf(await run(checkRouter, peeks)).includes('A4'));
  const outside = { ...router, route: async () => ({ member: 'nobody-of-these' }) };
  assert.ok(rulesOf(await run(checkRouter, outside)).includes('A1'));

  const attribution = referenceAttribution();
  const copies = { ...attribution, attribute: async (input: any) => (await attribution.attribute(input)).map((a) => ({ ...a, evidence: [...a.evidence, input.result.output, input.record.at(-1)?.reason?.detail ?? ''] })) };
  assert.ok(rulesOf(await run(checkAttribution, copies)).includes('At5'));
  const all = { ...attribution, attribute: async (input: any) => input.record.filter((h: any) => h.status !== 'completed').map((h: any) => ({ layer: 'member', member: h.member, hopId: h.hopId, confidence: 0.5, evidence: [], by: 'x' })) };
  assert.ok(rulesOf(await run(checkAttribution, all)).includes('At3'));
  assert.ok(rulesOf(await run(checkAttribution, all)).includes('At4'));
  const parses = { ...attribution, attribute: async (input: any) => (input.record.some((h: any) => h.reason?.detail) ? [] : attribution.attribute(input)) };
  assert.ok(rulesOf(await run(checkAttribution, parses)).includes('At6'));
});

test('host: each defect fails its rule', async () => {
  const host = prototypeHost({ quiet: true });
  const handsOver: Host = { ...host, gate: { ...host.gate, token: async (caller) => caller?.credential } };
  assert.ok(rulesOf(await run(checkHost, handsOver)).includes('H4'));
  const open: Host = { ...host, gate: { ...host.gate, allow: async () => ({ effect: 'allow' }) } };
  assert.ok(rulesOf(await run(checkHost, open)).includes('H3'));
  assert.deepEqual(rulesOf(await run(checkHost, open, { othersMayResume: true })), []);
  const swallows: Host = { ...host, telemetry: { ...host.telemetry, span: async (_n, _a, fn) => fn({ set() {}, event() {} }).catch(() => undefined as never) } };
  assert.ok(rulesOf(await run(checkHost, swallows)).includes('H6'));
  const throws: Host = { ...host, telemetry: { ...host.telemetry, event: () => { throw new Error('no'); } } };
  assert.ok(rulesOf(await run(checkHost, throws)).includes('H6'));
  const badTier = { ...host, tier: 'staging' } as unknown as Host;
  assert.ok(rulesOf(await run(checkHost, badTier)).includes('H1'));
  const state = new Map<string, unknown>();
  const sharing: Host = { ...host, state: { get: async (k) => state.get(k), set: async (k, v) => { state.set(k, v); }, delete: async (k) => { state.delete(k); } } };
  assert.ok(rulesOf(await run(checkHost, sharing)).includes('H8'));
});

test('checkAdapter: descriptor and create problems are D rules; failuresOf and failuresExcept split a report', async () => {
  const broken = { ...executionAdapter, portVersion: '9.0.0', optionsSchema: undefined, limits: { maxRuns: { path: 'options.maxRuns', default: 1, unit: 'count', min: 1, why: 'x' } } } as never;
  const report = await checkAdapter(broken);
  assert.ok(failuresOf(report, 'D1').some((f) => f.includes('portVersion') || f.includes('implements')));
  assert.ok(failuresOf(report, 'D2').some((f) => f.includes('options.maxRuns')));
  const refused = await checkAdapter(topologyAdapter, { options: { unknown: true } });
  assert.ok(failuresOf(refused, 'D3').length > 0);
  assert.deepEqual(failuresExcept(refused, 'D3'), []);
  const ok = await checkAdapter(executionAdapter);
  assert.equal(ok.ok, true);
  assert.ok(ok.rules.includes('E1') && ok.rules.includes('D3'));
  assert.equal((await conformance('Host', prototypeHost({ quiet: true }))).ok, true);
});

test('fakeScope queues calls beyond maxParallel, like the core', async () => {
  const scope = fakeScope({ limits: { maxParallel: 2 }, members: { a: async () => { await sleep(10); return { status: 'completed', output: '' }; } } });
  await Promise.all([1, 2, 3, 4, 5].map((i) => scope.call('a', 'x', { node: `root.branches[${i}]`, share: 0.2 })));
  assert.equal(scope.calls.length, 5);
  assert.equal(scope.maxInFlight, 2);
});

test('checkSystem runs an adapter inside an assembled system', async () => {
  const report = await checkSystem(executionAdapter, { adapters: [topologyAdapter, attributionAdapter] });
  assert.deepEqual(report.failures, []);
  assert.ok(report.rules.includes('S1'));
  assert.ok(report.skipped.some((s) => s.startsWith('S2')), 'the reference topology runs no parallel');
  const member = await checkSystem(memberAdapter, { adapters: [topologyAdapter, executionAdapter, attributionAdapter] });
  assert.deepEqual(member.failures, []);
  // A topology that runs parallel but whose parallel run fails is a failure of S2, not a skip.
  const broken = defineAdapter<'TopologyPort'>({
    ...topologyAdapter,
    name: 'broken-parallel',
    create: async (options, ctx) => {
      const inner = await topologyAdapter.create(options, ctx);
      return {
        ...inner, kinds: [...inner.kinds, 'parallel'],
        bind: (spec, info) => (spec.kind === 'parallel' ? { run: async () => ({ status: 'failed', output: '', reason: { code: 'error', layer: 'topology' } }) } : inner.bind(spec, info)),
      };
    },
  });
  const failing = await checkSystem(executionAdapter, { adapters: [broken, attributionAdapter] });
  assert.ok(!failing.skipped.some((s) => s.startsWith('S2')), failing.skipped.join('\n'));
  assert.ok(failuresOf(failing, 'S2').some((f) => f.includes('the parallel run must complete, got failed/error')), failing.failures.join('\n'));
  const missing = await checkSystem(memberAdapter, { adapters: [] });
  assert.ok(failuresOf(missing, 'S1').length > 0);
  assert.ok(CANARY_CREDENTIAL.length > 0);
});
