import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineAdapter, type AdapterDescriptor, type Tier } from '../src/adapter.ts';
import { assemble } from '../src/assemble.ts';
import { resolveConfig } from '../src/config.ts';
import { AdapterError, ConfigError } from '../src/errors.ts';
import type { AgentRouterPort, AttributionPort, BoundTopology, ExecutionPort, RegistryPort, RunScope, TopologyPort } from '../src/ports.ts';
import { prototypeHost } from '../src/prototype-host.ts';
import type { Attribution, MemberResult, RunInput, TopologyNode } from '../src/shapes.ts';
import { inputText } from '../src/shapes.ts';
import { recordingHost, member as fakeMemberPort, memoryExecution } from './fakes.ts';

const maps = { standard: 'none' };
const both: Tier[] = ['prototype', 'production'];

interface Probe { closed: number; begun: string[] }

function descriptors(probe: Probe, tiers: Tier[] = both): AdapterDescriptor[] {
  const member = defineAdapter({
    fills: 'MemberPort', name: 'fake-member', maps, tiers, portVersion: '0.1.0',
    optionsSchema: { type: 'object', required: ['reply'], properties: { reply: { type: 'string' }, audience: { type: 'string' }, signed: { type: 'boolean' }, tokens: { type: 'integer' } }, additionalProperties: false },
    create: (o: { reply: string; audience?: string; signed?: boolean; tokens?: number }, ctx) => fakeMemberPort(ctx.name, async (input) => ({
      status: 'completed', output: `${ctx.name}:${o.reply}:${inputText(input as RunInput)}`,
      ...(o.tokens ? { usage: { inputTokens: o.tokens, outputTokens: 0 } } : {}),
    }), { ...(o.audience ? { audience: o.audience } : {}), trust: { signed: !!o.signed, pinned: false } }),
  });
  const registry = defineAdapter({
    fills: 'RegistryPort', name: 'fake-registry', maps, tiers, portVersion: '0.1.0',
    create: (_o, ctx): RegistryPort => ({
      name: 'fake-registry',
      list: async () => ctx.members!(),
      get: async (id) => (await ctx.members!()).find((e) => e.id === id),
    }),
  });
  const router = defineAdapter({
    fills: 'AgentRouterPort', name: 'fake-router', maps, tiers, portVersion: '0.1.0',
    create: (o: { pick?: string }): AgentRouterPort => ({
      name: 'fake-router',
      route: async (q) => (o.pick ? { member: o.pick } : q.candidates[0] ? { member: q.candidates[0].id } : {}),
    }),
  });
  const topology = defineAdapter({
    fills: 'TopologyPort', name: 'fake-topology', maps, tiers, portVersion: '0.1.0',
    create: (): TopologyPort => ({
      name: 'fake-topology',
      kinds: ['sequence', 'route'],
      bind: (spec): BoundTopology => ({
        async run(input, scope) {
          const walk = async (node: TopologyNode, text: RunInput, path: string): Promise<MemberResult> => {
            if (typeof node === 'string') return (await scope.call(node, text, { node: path })).result;
            if (node.kind === 'sequence') {
              let last: MemberResult = { status: 'completed', output: inputText(text) };
              for (const [i, step] of node.steps.entries()) {
                last = await walk(step, last.output, `${path}.steps[${i}]`);
                if (last.status !== 'completed') return last;
              }
              return last;
            }
            if (node.kind === 'route') {
              const d = await scope.route({ input: text, candidates: node.candidates, ...(node.router ? { router: node.router } : {}), node: path });
              if (d.member) return walk(d.member, text, path);
              return node.fallback ? walk(node.fallback, text, `${path}.fallback`) : { status: 'stopped', output: '', reason: { code: 'rejected', layer: 'routing' } };
            }
            throw new Error('unsupported');
          };
          return walk(spec, input, 'root');
        },
      }),
    }),
  });
  const execution = defineAdapter({
    fills: 'ExecutionPort', name: 'fake-execution', maps, tiers, portVersion: '0.1.0',
    create: (): ExecutionPort & { close(): void } => {
      const inner = memoryExecution();
      return { ...inner, begin: (key) => { probe.begun.push(key); return inner.begin(key); }, close: () => { probe.closed++; } };
    },
  });
  const attribution = defineAdapter({
    fills: 'AttributionPort', name: 'fake-attribution', maps, tiers, portVersion: '0.1.0',
    create: (): AttributionPort => ({
      name: 'fake-attribution',
      async attribute({ record, source }) {
        const bad = record.find((h) => h.status !== 'completed');
        const known = source ? (await source.records(record[0]?.rootRunId ?? '')).length : 0;
        if (!bad) return [];
        const layer = bad.reason?.layer === 'host' ? 'host' : 'member';
        return [{ layer, member: bad.member, hopId: bad.hopId, confidence: 1, evidence: [`source:${known}`], by: 'fake-attribution' } as Attribution];
      },
    }),
  });
  return [member, registry, router, topology, execution, attribution] as unknown as AdapterDescriptor[];
}

const rawConfig = (over: Record<string, unknown> = {}) => ({
  system: { name: 'support' },
  members: {
    triage: { adapter: 'fake-member', options: { reply: 'T' } },
    billing: { adapter: 'fake-member', options: { reply: 'B', audience: 'billing' } },
  },
  ports: {
    registry: { adapter: 'fake-registry' },
    router: { adapter: 'fake-router' },
    topology: { adapter: 'fake-topology' },
    execution: { adapter: 'fake-execution' },
    attribution: { adapter: 'fake-attribution' },
  },
  topology: { kind: 'sequence', steps: ['triage', { kind: 'route', candidates: ['billing'], fallback: 'triage' }] },
  ...over,
});

async function build(over: Record<string, unknown> = {}, opts: { tiers?: Tier[]; host?: ReturnType<typeof recordingHost>['host']; profile?: string } = {}) {
  const probe: Probe = { closed: 0, begun: [] };
  const all = descriptors(probe, opts.tiers);
  const config = resolveConfig(rawConfig(over), { cwd: process.cwd(), ...(opts.profile ? { profile: opts.profile } : {}) });
  const system = await assemble(config, {
    host: opts.host ?? prototypeHost({ quiet: true }),
    resolveAdapter: async (fills, name) => {
      const found = all.find((d) => d.fills === fills && d.name === name);
      if (!found) throw new Error('is not installed');
      return found;
    },
  });
  return { system, probe };
}

test('a sequence with a routed step runs end to end', async () => {
  const h = recordingHost();
  const { system } = await build({}, { host: h.host });
  const res = await system.run('hi');
  assert.equal(res.status, 'completed');
  assert.equal(res.output, 'billing:B:triage:T:hi');
  assert.equal(res.record.length, 2);
  assert.deepEqual(res.record.map((r) => [r.member, r.node, r.status]), [['triage', 'root.steps[0]', 'completed'], ['billing', 'root.steps[1]', 'completed']]);
  assert.ok(res.record.every((r) => r.rootRunId === res.runId));
  assert.ok(res.runId.length > 10);
  const names = h.spans.map((s) => s.name).sort();
  assert.deepEqual(names, ['plexus.hop', 'plexus.hop', 'plexus.route', 'plexus.run']);
  assert.equal(h.spans.find((s) => s.name === 'plexus.route')!.attrs['plexus.layer'], 'routing');
  assert.equal(h.spans.find((s) => s.name === 'plexus.route')!.attrs['plexus.route.choice'], 'billing');
  const run = h.spans.find((s) => s.name === 'plexus.run')!;
  assert.equal(run.attrs['plexus.layer'], 'topology');
  assert.equal(run.attrs['plexus.run.status'], 'completed');
});

test('entries come from the members, with the config id', async () => {
  const { system } = await build();
  assert.deepEqual((await system.entries()).map((e) => [e.id, e.audience]), [['triage', undefined], ['billing', 'billing']]);
});

test('a router that picks outside the candidates is ignored: the fallback runs', async () => {
  const { system } = await build({ ports: { ...rawConfig().ports, router: { adapter: 'fake-router', options: { pick: 'triage' } } } });
  const res = await system.run('hi');
  assert.deepEqual(res.record.map((r) => r.member), ['triage', '', 'triage']);
  assert.deepEqual(res.record[1], { ...res.record[1], status: 'stopped', reason: { code: 'rejected', layer: 'routing' }, node: 'root.steps[1]', durationMs: 0, route: {} });
});

test('lineage keeps the root run id; the journal is keyed by the run, never by the session', async () => {
  const { system, probe } = await build();
  const res = await system.run('hi', { lineage: { rootRunId: 'root-9', parentRunId: 'p' }, sessionId: 's1', caller: { id: 'u1', kind: 'user', roles: [], scopes: [] } });
  assert.ok(res.record.every((r) => r.rootRunId === 'root-9'));
  assert.deepEqual(probe.begun, [res.runId]);
  const again = await system.run('again', { sessionId: 's1' });
  assert.deepEqual(probe.begun, [res.runId, again.runId]);
});

test('a run past its deadline stops with timeout before calling anyone', async () => {
  const { system } = await build();
  const res = await system.run('hi', { bounds: { deadlineAt: new Date(Date.now() - 1000).toISOString(), hops: 0, maxHops: 3 } });
  assert.equal(res.status, 'stopped');
  assert.equal(res.reason?.code, 'timeout');
  assert.equal(res.record.length, 0);
});

test('the system limits cap the run: maxSteps', async () => {
  const { system } = await build({ limits: { system: { maxSteps: 1 } } });
  const res = await system.run('hi');
  assert.equal(res.status, 'stopped');
  assert.equal(res.reason?.code, 'limit');
  assert.equal(res.record.length, 2);
});

test('the host gate applies to every call and attribution reads past runs', async () => {
  const h = recordingHost({ allow: (q) => (q.member.id === 'billing' ? { effect: 'deny' } : { effect: 'allow' }) });
  const { system } = await build({}, { host: h.host });
  const res = await system.run('hi');
  assert.equal(res.status, 'stopped');
  assert.equal(res.reason?.code, 'denied');
  const attributions = await system.attribute(res);
  assert.equal(attributions[0]?.layer, 'host');
  assert.equal(attributions[0]?.member, 'billing');
  assert.deepEqual(attributions[0]?.evidence, ['source:2']);
});

test('only the last 100 runs are kept for attribution', async () => {
  const { system } = await build({ topology: { kind: 'sequence', steps: ['triage'] } });
  const first = await system.run('x');
  for (let i = 0; i < 100; i++) await system.run('x');
  const attributions = await system.attribute({ ...first, status: 'stopped', record: first.record.map((r) => ({ ...r, status: 'stopped' as const })) });
  assert.equal(attributions[0]?.evidence[0], 'source:0');
});

test('a topology that throws becomes a failed result in the topology layer', async () => {
  const { system } = await build({ topology: { kind: 'sequence', steps: ['triage', { kind: 'route', candidates: ['billing'], router: 'nope' }] } });
  const res = await system.run('hi');
  assert.equal(res.status, 'stopped');
  assert.equal(res.reason?.layer, 'routing');
});

test('score goes through the prototype host and reads stored member outputs', async () => {
  const probe: Probe = { closed: 0, begun: [] };
  const all = descriptors(probe);
  const system = await assemble(resolveConfig(rawConfig(), { cwd: '.' }), { resolveAdapter: async (f, n) => all.find((d) => d.fills === f && d.name === n)! });
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  const res = await system.run('hi').finally(() => { process.stderr.write = write; });
  const scores = await system.score({ id: 'c', input: 'hi', expected: { output: { contains: 'B:' }, members: { triage: { contains: 'T:hi' } } } }, res);
  assert.deepEqual(scores.map((s) => [s.metric, s.value]), [['expected.output', 1], ['expected.member', 1]]);
});

test('close reaches adapters that have a close', async () => {
  const { system, probe } = await build();
  await system.close();
  assert.equal(probe.closed, 1);
});

test('adapter errors name the config path', async () => {
  await assert.rejects(build({ members: { triage: { adapter: 'ghost' } } }), (e: unknown) => e instanceof AdapterError && e.message.startsWith('$.members.triage: adapter "ghost"'));
  await assert.rejects(build({ members: { triage: { adapter: 'fake-member', options: { reply: 1, extra: true } } } }), (e: unknown) => {
    assert.ok(e instanceof ConfigError);
    assert.deepEqual(e.errors.sort(), ['$.members.triage.options.extra: unknown property', '$.members.triage.options.reply: expected string, got integer']);
    return true;
  });
  await assert.rejects(build({ ports: { ...rawConfig().ports, execution: { adapter: 'fake-attribution' } } }), /\$\.ports\.execution/);
});

test('check: a clean prototype system has no findings', async () => {
  const { system } = await build();
  assert.deepEqual(await system.check(), []);
});

test('check: topology problems fail, on any tier', async () => {
  const { system } = await build({ topology: { kind: 'sequence', steps: ['triage', 'ghost', { kind: 'loop', body: 'triage', until: {} }] } });
  const msgs = (await system.check()).map((f) => f.message);
  assert.ok(msgs.includes('root.steps[1]: unknown member "ghost"'));
  assert.ok(msgs.includes('root.steps[2]: kind "loop" is not supported by the topology adapter'));
});

test('check: a production tier fails on a prototype host, prototype-only adapters and unbounded limits', async () => {
  const { system } = await build({ tier: 'production', limits: { system: { timeoutMs: 'unbounded', maxParallel: 32 } } }, { tiers: ['prototype'] });
  const findings = await system.check();
  const fails = findings.filter((f) => f.severity === 'fail').map((f) => f.path);
  assert.ok(fails.includes('$.host'));
  for (const p of ['$.members.triage', '$.members.billing', '$.ports.registry', '$.ports.router', '$.ports.topology', '$.ports.execution', '$.ports.attribution']) assert.ok(fails.includes(p), p);
  assert.ok(fails.includes('limits.system.timeoutMs'));
  assert.equal(findings.find((f) => f.path === 'limits.system.maxParallel')?.severity, 'warn');
});

test('check: a production tier with a production host and adapters is clean', async () => {
  const h = recordingHost({ tier: 'production' });
  const { system } = await build({ tier: 'production' }, { host: h.host });
  assert.deepEqual(await system.check(), []);
});

test('check: registry.requireSigned fails members with neither a signed card nor a pinned endpoint', async () => {
  const { system } = await build({
    registry: { requireSigned: true },
    members: { triage: { adapter: 'fake-member', options: { reply: 'T', signed: true } }, billing: { adapter: 'fake-member', options: { reply: 'B' } } },
  });
  const findings = await system.check();
  assert.deepEqual(findings.map((f) => [f.severity, f.path]), [['fail', '$.members.billing']]);
});

test('the profile selects the tier used by check', async () => {
  const { system } = await build({ profiles: { production: { tier: 'production' } } }, { profile: 'production' });
  assert.equal(system.tier, 'production');
  assert.ok((await system.check()).some((f) => f.path === '$.host'));
});

test('a route that chose nobody writes a routing hop and does not count as a step', async () => {
  const { system } = await build({ limits: { system: { maxSteps: 2 } }, ports: { ...rawConfig().ports, router: { adapter: 'fake-router', options: { pick: 'triage' } } } });
  const res = await system.run('hi');
  assert.equal(res.status, 'completed');
  assert.equal(res.record.length, 3);
  assert.equal(res.record[1]?.member, '');
});

test('${env:...} in adapter options is filled in; a missing variable names its path', async () => {
  const probe: Probe = { closed: 0, begun: [] };
  const all = descriptors(probe);
  const make = (reply: string, env: Record<string, string>) => assemble(
    resolveConfig(rawConfig({ members: { triage: { adapter: 'fake-member', options: { reply } } }, topology: { kind: 'sequence', steps: ['triage'] } }), { cwd: '.' }),
    { host: prototypeHost({ quiet: true }), env, resolveAdapter: async (f, n) => all.find((d) => d.fills === f && d.name === n)! },
  );
  const system = await make('a-${env:X}-${env:Y:-d}', { X: 'x' });
  assert.equal((await system.run('q')).output, 'triage:a-x-d:q');
  await assert.rejects(make('${env:NOPE}', {}), (e: unknown) => e instanceof ConfigError && e.errors[0] === '$.members.triage.options.reply: environment variable NOPE is not set');
});
