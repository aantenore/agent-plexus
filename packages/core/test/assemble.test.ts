import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defineAdapter, type AdapterContext, type AdapterDescriptor, type Tier } from '../src/adapter.ts';
import { assemble } from '../src/assemble.ts';
import { resolveConfig } from '../src/config.ts';
import { AdapterError, ConfigError, RunBusyError } from '../src/errors.ts';
import type { AgentRouterPort, AttributionPort, BoundTopology, ExecutionPort, MemberPort, RegistryPort, RunScope, TopologyPort } from '../src/ports.ts';
import { prototypeHost } from '../src/prototype-host.ts';
import type { GateQuestion } from '../src/hooks.ts';
import type { AgentEntry, Attribution, MemberResult, RouteDecision, RunInput, TopologyNode } from '../src/shapes.ts';
import { inputText } from '../src/shapes.ts';
import { recordingHost, member as fakeMemberPort, memoryExecution, type FakeExecution } from './fakes.ts';

const maps = { standard: 'none' };
const both: Tier[] = ['prototype', 'production'];

interface Probe { closed: number; begun: string[]; scopes: RunScope[] }

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
          probe.scopes.push(scope);
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

async function build(over: Record<string, unknown> = {}, opts: { tiers?: Tier[]; host?: ReturnType<typeof recordingHost>['host']; profile?: string; extra?: AdapterDescriptor[] } = {}) {
  const probe: Probe = { closed: 0, begun: [], scopes: [] };
  const all = [...(opts.extra ?? []), ...descriptors(probe, opts.tiers)];
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

test('a member is asked to describe itself again after limits.system.describeTtlMs and not before; 0 asks every time', async () => {
  const asked = { n: 0 };
  const counting = defineAdapter({
    fills: 'MemberPort', name: 'counting-member', maps, tiers: both, portVersion: '0.1.0',
    create: (_o, ctx): MemberPort => {
      const port = fakeMemberPort(ctx.name, async () => ({ status: 'completed', output: 'ok' }));
      return { ...port, describe: async () => { asked.n++; return port.describe(); } };
    },
  });
  const members = { triage: { adapter: 'counting-member' }, billing: { adapter: 'fake-member', options: { reply: 'B' } } };
  const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, ms));

  const kept = (await build({ members }, { extra: [counting] })).system;
  await kept.entries();
  await kept.entries();
  await kept.check();
  assert.equal(asked.n, 1, 'within the default minute the first answer stands');

  asked.n = 0;
  const expiring = (await build({ members, limits: { system: { describeTtlMs: 20 } } }, { extra: [counting] })).system;
  await expiring.entries();
  await sleep(50);
  await expiring.entries();
  assert.equal(asked.n, 2, 'asked again once the answer is older than describeTtlMs');

  asked.n = 0;
  const always = (await build({ members, limits: { system: { describeTtlMs: 0 } } }, { extra: [counting] })).system;
  await always.entries();
  await always.entries();
  assert.equal(asked.n, 2, 'describeTtlMs 0 asks on every use');
});

test('a router that picks outside the candidates is a routing failure: a failed routing hop, then the fallback runs', async () => {
  const { system } = await build({ ports: { ...rawConfig().ports, router: { adapter: 'fake-router', options: { pick: 'triage' } } } });
  const res = await system.run('hi');
  assert.deepEqual(res.record.map((r) => r.member), ['triage', '', 'triage']);
  assert.deepEqual(res.record[1], {
    ...res.record[1], status: 'failed', reason: { code: 'error', layer: 'routing', detail: 'router chose a member outside the candidates' }, node: 'root.steps[1]', durationMs: 0, route: {},
  });
});

test('lineage keeps the root run id; the journal is keyed by the run, never by the session', async () => {
  const { system, probe } = await build();
  const res = await system.run('hi', { lineage: { rootRunId: 'root-9', parentRunId: 'p' }, sessionId: 's1', caller: { id: 'u1', kind: 'user', roles: [], scopes: [] } });
  assert.ok(res.record.every((r) => r.rootRunId === 'root-9'));
  assert.deepEqual(probe.begun, [res.runId]);
  const again = await system.run('again', { sessionId: 's1' });
  assert.deepEqual(probe.begun, [res.runId, again.runId]);
});

test('the scope handed to a topology carries the caller without its credential; the gate still gets it for a token', async () => {
  const seen: (string | undefined)[] = [];
  const h = recordingHost({ token: async (caller) => { seen.push(caller?.credential); return 'aud-token'; } });
  const { system, probe } = await build({}, { host: h.host });
  const res = await system.run('hi', { caller: { id: 'u1', kind: 'user', roles: [], scopes: [], credential: 'SECRET-CREDENTIAL' } });
  assert.equal(res.status, 'completed');
  assert.equal(probe.scopes[0]?.ctx.caller?.id, 'u1');
  assert.equal(probe.scopes[0]?.ctx.caller?.credential, undefined);
  assert.deepEqual(seen, ['SECRET-CREDENTIAL']);
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
  const h = recordingHost({ allow: (q) => (q.member?.id === 'billing' ? { effect: 'deny' } : { effect: 'allow' }) });
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

test('over limits.attribution.maxRecords the failing last hop is still attributed', async () => {
  const { system } = await build({ topology: { kind: 'sequence', steps: ['triage'] }, limits: { attribution: { maxRecords: 3 } } });
  const run = await system.run('x');
  const hop = run.record[0]!;
  const record = Array.from({ length: 6 }, (_, i) => ({ ...hop, hopId: `h${i}`, status: i === 5 ? ('stopped' as const) : ('completed' as const) }));
  const attributions = await system.attribute({ ...run, status: 'stopped', record });
  assert.equal(attributions[0]?.hopId, 'h5');
});

test('a topology that throws becomes a failed result in the topology layer', async () => {
  const { system } = await build({ topology: { kind: 'sequence', steps: ['triage', { kind: 'route', candidates: ['billing'], router: 'nope' }] } });
  const res = await system.run('hi');
  assert.equal(res.status, 'stopped');
  assert.equal(res.reason?.layer, 'routing');
});

test('score goes through the prototype host and reads stored member outputs', async () => {
  const probe: Probe = { closed: 0, begun: [], scopes: [] };
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

test('an optional route that chose nobody writes no hop; a plain one writes a rejected routing hop', async () => {
  const routing = (optional: boolean) => defineAdapter({
    fills: 'TopologyPort', name: 'ending-topology', maps, tiers: both, portVersion: '0.1.0',
    create: (): TopologyPort => ({
      name: 'ending-topology',
      kinds: ['sequence'],
      bind: (): BoundTopology => ({
        async run(input, scope) {
          const first = (await scope.call('triage', input, { node: 'root.turns[0]' })).result;
          const next = await scope.route({ input: first.output, candidates: ['ghost'], node: 'root.turns[1]', ...(optional ? { optional } : {}) });
          assert.equal(next.member, undefined);
          return first;
        },
      }),
    }),
  }) as unknown as AdapterDescriptor;
  const over = { topology: { kind: 'sequence', steps: ['triage'] }, ports: { ...rawConfig().ports, topology: { adapter: 'ending-topology' } } };
  const quiet = await build(over, { extra: [routing(true)] });
  const ended = await quiet.system.run('hi');
  assert.equal(ended.status, 'completed');
  assert.deepEqual(ended.record.map((h) => [h.member, h.status]), [['triage', 'completed']]);
  const plain = await build(over, { extra: [routing(false)] });
  const rejected = await plain.system.run('hi');
  assert.deepEqual(rejected.record.map((h) => [h.member, h.status, h.reason?.code, h.reason?.layer]), [
    ['triage', 'completed', undefined, undefined], ['', 'stopped', 'rejected', 'routing'],
  ]);
});

test('${env:...} in adapter options is filled in; a missing variable names its path', async () => {
  const probe: Probe = { closed: 0, begun: [], scopes: [] };
  const all = descriptors(probe);
  const make = (reply: string, env: Record<string, string>) => assemble(
    resolveConfig(rawConfig({ members: { triage: { adapter: 'fake-member', options: { reply } } }, topology: { kind: 'sequence', steps: ['triage'] } }), { cwd: '.' }),
    { host: prototypeHost({ quiet: true }), env, resolveAdapter: async (f, n) => all.find((d) => d.fills === f && d.name === n)! },
  );
  const system = await make('a-${env:X}-${env:Y:-d}', { X: 'x' });
  assert.equal((await system.run('q')).output, 'triage:a-x-d:q');
  await assert.rejects(make('${env:NOPE}', {}), (e: unknown) => e instanceof ConfigError && e.errors[0] === '$.members.triage.options.reply: environment variable NOPE is not set');
});

const registryOf = (name: string, list: (ctx: AdapterContext) => Promise<AgentEntry[]>) => defineAdapter({
  fills: 'RegistryPort', name, maps, tiers: both, portVersion: '0.1.0',
  create: (_o, ctx): RegistryPort => ({ name, list: () => list(ctx), get: async () => undefined }),
}) as unknown as AdapterDescriptor;

const topologyOf = (name: string, bindError: string) => defineAdapter({
  fills: 'TopologyPort', name, maps, tiers: both, portVersion: '0.1.0',
  create: (): TopologyPort => ({ name, kinds: ['sequence', 'route'], bind: () => { throw new Error(bindError); } }),
}) as unknown as AdapterDescriptor;

test('adapters are created with the name of the system', async () => {
  const seen: string[] = [];
  const spy = defineAdapter({
    fills: 'MemberPort', name: 'spy-member', maps, tiers: both, portVersion: '0.1.0',
    create: (_o, ctx) => { seen.push(ctx.system); return fakeMemberPort(ctx.name, async () => ({ status: 'completed', output: 'x' })); },
  }) as unknown as AdapterDescriptor;
  await build({ members: { triage: { adapter: 'spy-member' }, billing: { adapter: 'spy-member' } } }, { extra: [spy] });
  assert.deepEqual(seen, ['support', 'support']);
});

test('run uses the run id the caller provides, and generates one otherwise', async () => {
  const { system, probe } = await build({ topology: { kind: 'sequence', steps: ['triage'] } });
  const mine = await system.run('x', { runId: 'caller-run-1' });
  assert.equal(mine.runId, 'caller-run-1');
  assert.equal(probe.scopes.at(-1)?.ctx.runId, 'caller-run-1');
  assert.deepEqual(probe.begun, ['caller-run-1']);
  assert.equal((await system.run('x', { runId: 'r'.repeat(128) })).runId.length, 128);
  for (const runId of ['', 'r'.repeat(129), 42 as never]) {
    const res = await system.run('x', { runId });
    assert.notEqual(res.runId, runId);
    assert.ok(res.runId.length > 10 && res.runId.length <= 128);
  }
});

test('check: a registry entry that is not a configured member fails', async () => {
  const ghost = registryOf('ghost-registry', async (ctx) => [...(await ctx.members!()), { ...(await ctx.members!())[0]!, id: 'ghost' }]);
  const { system } = await build({ ports: { ...rawConfig().ports, registry: { adapter: 'ghost-registry' } } }, { extra: [ghost] });
  const findings = await system.check();
  assert.deepEqual(findings.map((f) => [f.severity, f.path, f.message]), [['fail', '$.ports.registry', 'entry "ghost" is not a configured member']]);
});

test('check: a registry that throws is a failure, not an exception', async () => {
  const broken = registryOf('broken-registry', async () => { throw new Error('registry down'); });
  const { system } = await build({ ports: { ...rawConfig().ports, registry: { adapter: 'broken-registry' } } }, { extra: [broken] });
  const findings = await system.check();
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0]!.severity, findings[0]!.path], ['fail', '$.ports.registry']);
  assert.match(findings[0]!.message, /registry down/);
});

test('check: an unsupported kind that fails the bind is reported once, by the core', async () => {
  const strict = topologyOf('strict-topology', 'strict-topology: node "root.steps[1]" has unsupported kind "loop"');
  const { system } = await build(
    { ports: { ...rawConfig().ports, topology: { adapter: 'strict-topology' } }, topology: { kind: 'sequence', steps: ['triage', { kind: 'loop', body: 'triage', until: {} }] } },
    { extra: [strict] },
  );
  const msgs = (await system.check()).map((f) => f.message);
  assert.deepEqual(msgs, ['root.steps[1]: kind "loop" is not supported by the topology adapter']);
  assert.equal((await system.run('x')).reason?.layer, 'topology');
});

test('check: a bind failure the core does not explain is reported with the adapter message', async () => {
  const odd = topologyOf('odd-topology', 'cannot start');
  const { system } = await build({ ports: { ...rawConfig().ports, topology: { adapter: 'odd-topology' } } }, { extra: [odd] });
  assert.deepEqual((await system.check()).map((f) => f.message), ['topology could not be bound: cannot start']);
});

test('limits.attribution.historyRuns bounds the runs kept for attribution', async () => {
  const { system } = await build({ topology: { kind: 'sequence', steps: ['triage'] }, limits: { attribution: { historyRuns: 1 } } });
  const first = await system.run('x');
  await system.run('x');
  const attributions = await system.attribute({ ...first, status: 'stopped', record: first.record.map((r) => ({ ...r, status: 'stopped' as const })) });
  assert.equal(attributions[0]?.evidence[0], 'source:0');
  const kept = await build({ topology: { kind: 'sequence', steps: ['triage'] }, limits: { attribution: { historyRuns: 2 } } });
  const one = await kept.system.run('x');
  await kept.system.run('x');
  const again = await kept.system.attribute({ ...one, status: 'stopped', record: one.record.map((r) => ({ ...r, status: 'stopped' as const })) });
  assert.equal(again[0]?.evidence[0], 'source:1');
});

// Waiting runs and resume -------------------------------------------------------------------------------------------

interface AskingOptions { ask?: boolean; resume?: boolean; cancel?: boolean | 'throws'; tokens?: number; slow?: number; slowResume?: number; flaky?: boolean }

/**
 * Members that complete with `<id>:<input>`, or wait for input (`ask`) and continue through `resume`. `slow` delays the
 * answer by that many milliseconds, `slowResume` the answer to `resume`; `flaky` throws on the first call; `cancel` gives
 * the member a `cancel` (`throws`: one that fails).
 */
const askingMember = (calls: string[]) => defineAdapter({
  fills: 'MemberPort', name: 'asking-member', maps, tiers: both, portVersion: '0.1.0',
  create: (o: AskingOptions, ctx): MemberPort => {
    let broke = false;
    const port = fakeMemberPort(ctx.name, async (input) => {
      calls.push(`invoke:${ctx.name}`);
      if (o.slow) await new Promise((done) => setTimeout(done, o.slow));
      if (o.flaky && !broke) {
        broke = true;
        throw new Error('transient 503');
      }
      if (o.ask) return { status: 'waiting', output: '', reason: { code: 'needs_input', layer: 'member' }, taskRef: `task-${ctx.name}` };
      return { status: 'completed', output: `${ctx.name}:${inputText(input as RunInput)}`, ...(o.tokens ? { usage: { inputTokens: o.tokens, outputTokens: 0 } } : {}) };
    });
    if (o.resume !== false) {
      port.resume = async (ref, input) => {
        calls.push(`resume:${ctx.name}:${ref}:${input === undefined ? '-' : inputText(input)}`);
        if (o.slowResume) await new Promise((done) => setTimeout(done, o.slowResume));
        return { status: 'completed', output: `${ctx.name}:${input === undefined ? '-' : inputText(input)}` };
      };
    }
    if (o.cancel) {
      port.cancel = async (ref) => {
        calls.push(`cancel:${ctx.name}:${ref}`);
        if (o.cancel === 'throws') throw new Error('cancel refused');
      };
    }
    return port;
  },
}) as unknown as AdapterDescriptor;

const durableExecution = (journal: FakeExecution) => defineAdapter({
  fills: 'ExecutionPort', name: 'durable-execution', maps, tiers: both, portVersion: '0.1.0', create: (): ExecutionPort => journal,
}) as unknown as AdapterDescriptor;

/** A system over asking members and a durable journal; `ports` overrides the default ports. */
async function resumable(members: Record<string, AskingOptions>, topology: unknown, o: { host?: ReturnType<typeof recordingHost>['host']; ports?: Record<string, unknown>; extra?: AdapterDescriptor[] } = {}) {
  const calls: string[] = [];
  const journal = memoryExecution([], true);
  const { system } = await build(
    {
      members: Object.fromEntries(Object.entries(members).map(([id, options]) => [id, { adapter: 'asking-member', options }])),
      topology,
      ports: { ...rawConfig().ports, execution: { adapter: 'durable-execution' }, ...o.ports },
    },
    { extra: [askingMember(calls), durableExecution(journal), ...(o.extra ?? [])], ...(o.host ? { host: o.host } : {}) },
  );
  return { system, calls, journal };
}

const boss = { id: 'boss', kind: 'user' as const, roles: [], scopes: [], credential: 'BOSS-CREDENTIAL' };

/** A gate that lets anyone resume, asks before billing until it has an answer, then follows the answer. */
const askingGate = (questions: unknown[] = []) => recordingHost({
  allow: (q) => {
    questions.push(q);
    if (q.action !== 'invoke' || q.member.id !== 'billing') return { effect: 'allow' };
    if (!q.answer) return { effect: 'ask', reason: 'approval pending' };
    return q.answer.approved ? { effect: 'allow' } : { effect: 'deny', reason: q.answer.reason ?? 'refused' };
  },
});

test('a gate ask waits; resume with an approval asks the gate again with the answer and completes', async () => {
  const questions: { caller?: { id: string }; answer?: unknown; member: { id: string } }[] = [];
  const { system, calls, journal } = await resumable({ triage: {}, billing: {} }, { kind: 'sequence', steps: ['triage', 'billing'] }, { host: askingGate(questions).host });
  const first = await system.run('hi', { runId: 'r1', caller: { id: 'u1', kind: 'user', roles: [], scopes: [], credential: 'SECRET-CREDENTIAL' } });
  assert.equal(first.status, 'waiting');
  assert.deepEqual(first.reason, { code: 'needs_input', layer: 'host', by: 'test-host', detail: 'approval pending' });
  assert.ok(!JSON.stringify([...journal.kept.get('r1')!]).includes('SECRET-CREDENTIAL'));
  assert.deepEqual(journal.kept.get('r1')!.get('run:input'), 'hi');

  const res = await system.resume('r1', { approved: true, reason: 'ok' }, { caller: boss });
  assert.equal(res.status, 'completed', JSON.stringify(res.reason));
  assert.equal(res.output, 'billing:triage:hi');
  assert.equal(res.runId, 'r1');
  assert.deepEqual(calls, ['invoke:triage', 'invoke:billing']);
  const asked = questions.at(-1)!;
  assert.deepEqual([asked.member.id, asked.caller?.id, asked.answer], ['billing', 'boss', { approved: true, reason: 'ok', by: 'boss' }]);
  assert.deepEqual(res.record.map((h) => [h.member, h.status, h.attempt]), [['triage', 'completed', undefined], ['billing', 'completed', 1]]);
  assert.equal(journal.kept.get('r1')!.get('run:waiting'), null);
});

test('resume with a denial stops denied in the host layer', async () => {
  const { system, calls } = await resumable({ triage: {}, billing: {} }, { kind: 'sequence', steps: ['triage', 'billing'] }, { host: askingGate().host });
  assert.equal((await system.run('hi', { runId: 'r2' })).status, 'waiting');
  const res = await system.resume('r2', { approved: false, reason: 'not today' });
  assert.equal(res.status, 'stopped');
  assert.deepEqual([res.reason?.code, res.reason?.layer, res.reason?.detail], ['denied', 'host', 'not today']);
  assert.deepEqual(calls, ['invoke:triage']);
  assert.equal((await system.resume('r2', { approved: true })).reason?.detail, 'run r2 is not waiting');
});

test('a member waiting for input continues its task through resume with the reply, after the send check', async () => {
  const checked: string[] = [];
  const h = recordingHost({ check: (c) => { if (c.stage === 'send') checked.push(c.text); return { action: 'allow' }; } });
  const { system, calls } = await resumable({ triage: {}, billing: { ask: true } }, { kind: 'sequence', steps: ['triage', 'billing'] }, { host: h.host });
  const first = await system.run('hi', { runId: 'r3' });
  assert.deepEqual([first.status, first.reason?.code, first.reason?.layer], ['waiting', 'needs_input', 'member']);
  const res = await system.resume('r3', { input: 'my order is 42' });
  assert.equal(res.status, 'completed', JSON.stringify(res.reason));
  assert.equal(res.output, 'billing:my order is 42');
  assert.deepEqual(calls, ['invoke:triage', 'invoke:billing', 'resume:billing:task-billing:my order is 42']);
  assert.deepEqual(checked, ['hi', 'triage:hi', 'hi', 'my order is 42']);
  assert.equal(res.record.at(-1)?.attempt, 1);
  assert.ok(h.events.some((e) => e.name === 'plexus.member.resumed'));
});

test('a reply the send check blocks stops the resumed call; the member is not resumed', async () => {
  const h = recordingHost({ check: (c) => (c.stage === 'send' && c.text.includes('forbidden') ? { action: 'block' } : { action: 'allow' }) });
  const { system, calls } = await resumable({ billing: { ask: true } }, { kind: 'sequence', steps: ['billing'] }, { host: h.host });
  assert.equal((await system.run('hi', { runId: 'r4' })).status, 'waiting');
  const res = await system.resume('r4', { input: 'forbidden words' });
  assert.deepEqual([res.status, res.reason?.code, res.reason?.stage], ['stopped', 'guard_block', 'send']);
  assert.deepEqual(calls, ['invoke:billing']);
});

test('a run begun again without a reply still waits and calls nobody again', async () => {
  const { system, calls } = await resumable({ triage: {}, billing: { ask: true } }, { kind: 'sequence', steps: ['triage', 'billing'] });
  assert.equal((await system.run('hi', { runId: 'r5' })).status, 'waiting');
  const again = await system.run('hi', { runId: 'r5' });
  assert.deepEqual([again.status, again.reason?.code], ['waiting', 'needs_input']);
  assert.deepEqual(calls, ['invoke:triage', 'invoke:billing']);
  assert.equal((await system.resume('r5', { input: 'more' })).status, 'completed');
});

test('resume refuses a run that is not waiting, a reply of the wrong kind and an invalid reply', async () => {
  const { system } = await resumable({ triage: {}, billing: { ask: true } }, { kind: 'sequence', steps: ['triage', 'billing'] });
  const unknown = await system.resume('nobody', { input: 'x' });
  assert.deepEqual([unknown.status, unknown.reason?.code, unknown.reason?.layer, unknown.reason?.detail], ['failed', 'error', 'execution', 'run nobody is not waiting']);
  assert.equal((await system.run('hi', { runId: 'r6' })).status, 'waiting');
  assert.equal((await system.resume('r6', { approved: true })).reason?.detail, 'run r6 waits for input');
  assert.match((await system.resume('r6', { input: 'a', approved: true } as never)).reason?.detail ?? '', /invalid reply/);
  assert.match((await system.resume('', { input: 'a' })).reason?.detail ?? '', /invalid run id/);
  assert.equal((await system.resume('r6', { input: 'more' })).status, 'completed');
  assert.equal((await system.resume('r6', { input: 'again' })).reason?.detail, 'run r6 is not waiting');
});

test('a resume that cannot start leaves the stored status and the kept wait of the run as they were', async () => {
  const { system, journal } = await resumable({ triage: {}, billing: { ask: true } }, { kind: 'sequence', steps: ['triage', 'billing'] });
  assert.equal((await system.run('hi', { runId: 'r10' })).status, 'waiting');
  const kept = journal.kept.get('r10')!;
  const waiting = kept.get('run:waiting');
  assert.equal(journal.statuses.get('r10'), 'waiting');
  assert.equal((await system.resume('r10', { approved: true })).reason?.detail, 'run r10 waits for input');
  assert.equal(journal.statuses.get('r10'), 'waiting');
  assert.deepEqual(kept.get('run:waiting'), waiting);

  assert.equal((await system.resume('r10', { input: 'more' })).status, 'completed');
  assert.equal(journal.statuses.get('r10'), 'completed');
  const late = await system.resume('r10', { input: 'again' });
  assert.deepEqual([late.status, late.reason?.code, late.reason?.layer, late.reason?.detail], ['failed', 'error', 'execution', 'run r10 is not waiting']);
  assert.equal(journal.statuses.get('r10'), 'completed', 'a completed run is not relabelled failed');

  // A run in progress (input kept, never ended) stays in progress; a run the journal did not know is closed.
  const busy = await journal.begin('busy');
  await busy.remember('run:input', 'hi');
  assert.equal((await system.resume('busy', { input: 'x' })).reason?.detail, 'run busy is not waiting');
  assert.ok(journal.statuses.has('busy') && journal.statuses.get('busy') === undefined);
  await system.resume('nobody', { input: 'x' });
  assert.equal(journal.statuses.get('nobody'), 'failed');
});

test('a waiting member without resume stops with rejected in the member layer', async () => {
  const { system } = await resumable({ billing: { ask: true, resume: false } }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await system.run('hi', { runId: 'r7' })).status, 'waiting');
  const res = await system.resume('r7', { input: 'more' });
  assert.deepEqual([res.status, res.reason?.code, res.reason?.layer, res.reason?.detail], ['stopped', 'rejected', 'member', 'member billing cannot resume']);
});

test('after a resume a replay calls nobody again; the budget is the run\'s and replayed steps spend none of it', async () => {
  const { system, calls, journal } = await resumable({ triage: { tokens: 50 }, billing: {} }, { kind: 'sequence', steps: ['triage', 'billing'] }, { host: askingGate().host });
  const bounds = (tokens: number) => ({ deadlineAt: new Date(Date.now() + 60_000).toISOString(), hops: 0, maxHops: 5, tokens });
  assert.equal((await system.run('hi', { runId: 'r8', bounds: bounds(100) })).status, 'waiting');
  assert.deepEqual(journal.kept.get('r8')!.get('run:spent'), { tokens: 50, costUsd: 0 });
  const res = await system.resume('r8', { approved: true }, { bounds: bounds(100) });
  assert.equal(res.status, 'completed', JSON.stringify(res.reason));
  // billing reports nothing: the 50 tokens left were reserved for it and count as spent.
  assert.deepEqual(journal.kept.get('r8')!.get('run:spent'), { tokens: 100, costUsd: 0 });
  // The whole budget is spent, yet a replay goes through: replayed steps need none.
  const replay = await system.run('hi', { runId: 'r8', bounds: bounds(100) });
  // Every call replayed: this invocation spent nothing.
  assert.equal(replay.usage, undefined);
  assert.equal(replay.status, 'completed');
  assert.equal(replay.output, 'billing:triage:hi');
  assert.deepEqual(calls, ['invoke:triage', 'invoke:billing']);
  assert.deepEqual(replay.record.map((h) => h.attempt), [undefined, 1]);
});

test('route decisions are journal steps: a resumed run takes the path it took', async () => {
  let asked = 0;
  const fickle = defineAdapter({
    fills: 'AgentRouterPort', name: 'fickle-router', maps, tiers: both, portVersion: '0.1.0',
    create: (): AgentRouterPort => ({ name: 'fickle-router', route: async (q) => ({ member: q.candidates[asked++ % 2]!.id }) }),
  }) as unknown as AdapterDescriptor;
  const { system, calls } = await resumable(
    { billing: {}, triage: {} }, { kind: 'route', candidates: ['billing', 'triage'] },
    { host: askingGate().host, ports: { router: { adapter: 'fickle-router' } }, extra: [fickle] },
  );
  assert.equal((await system.run('hi', { runId: 'r9' })).status, 'waiting');
  const res = await system.resume('r9', { approved: true });
  assert.equal(res.output, 'billing:hi');
  assert.equal(asked, 1);
  assert.deepEqual(calls, ['invoke:billing']);
});

const emptyRegistry = (gets: { n: number }) => defineAdapter({
  fills: 'RegistryPort', name: 'empty-registry', maps, tiers: both, portVersion: '0.1.0',
  create: (): RegistryPort => ({ name: 'empty-registry', list: async () => [], get: async () => { gets.n++; return undefined; } }),
}) as unknown as AdapterDescriptor;

test('registry.requireListed: a member the registry does not return is denied before the gate, with one lookup per run', async () => {
  const gets = { n: 0 };
  const h = recordingHost();
  const { system } = await build(
    { registry: { requireListed: true }, topology: { kind: 'sequence', steps: ['triage'] }, ports: { ...rawConfig().ports, registry: { adapter: 'empty-registry' } } },
    { host: h.host, extra: [emptyRegistry(gets)] },
  );
  const res = await system.run('hi');
  assert.deepEqual([res.status, res.reason?.code, res.reason?.layer], ['stopped', 'denied', 'registry']);
  assert.deepEqual(h.log, []);
  assert.equal(gets.n, 1);
  assert.deepEqual((await system.check()).map((f) => [f.path, f.message]), [
    ['$.members.triage', 'member "triage" is not listed by the registry (registry.requireListed)'],
    ['$.members.billing', 'member "billing" is not listed by the registry (registry.requireListed)'],
  ]);
});

test('without registry.requireListed a registry that lists only routable members does not stop direct calls', async () => {
  const gets = { n: 0 };
  const { system } = await build({ topology: { kind: 'sequence', steps: ['triage'] }, ports: { ...rawConfig().ports, registry: { adapter: 'empty-registry' } } }, { extra: [emptyRegistry(gets)] });
  assert.equal((await system.run('hi')).status, 'completed');
  assert.equal(gets.n, 0);
});

test('registry.requireListed: the registry is asked once per member and run; without a registry it is a FAIL finding', async () => {
  let gets = 0;
  const counting = defineAdapter({
    fills: 'RegistryPort', name: 'counting-registry', maps, tiers: both, portVersion: '0.1.0',
    create: (_o, ctx): RegistryPort => ({ name: 'counting-registry', list: async () => ctx.members!(), get: async (id) => { gets++; return (await ctx.members!()).find((e) => e.id === id); } }),
  }) as unknown as AdapterDescriptor;
  const twice = { kind: 'sequence', steps: ['triage', 'triage'] };
  const listed = await build({ registry: { requireListed: true }, topology: twice, ports: { ...rawConfig().ports, registry: { adapter: 'counting-registry' } } }, { extra: [counting] });
  assert.equal((await listed.system.run('hi')).status, 'completed');
  assert.equal(gets, 1);
  assert.deepEqual(await listed.system.check(), []);
  const { registry: _registry, router: _router, ...ports } = rawConfig().ports;
  const bare = await build({ registry: { requireListed: true }, topology: twice, ports });
  assert.equal((await bare.system.run('hi')).status, 'completed');
  assert.deepEqual((await bare.system.check()).map((f) => f.path), ['$.registry.requireListed']);
});

// Resume authorization, step keys, reply claims and what is journaled ---------------------------------------------

type Branch = string | { kind: 'sequence'; steps: string[] };

/** Runs `branches` side by side; the result is the first branch, in order, that did not complete, with usage summed over every call. */
const branchingTopology = defineAdapter({
  fills: 'TopologyPort', name: 'branching-topology', maps, tiers: both, portVersion: '0.1.0',
  create: (): TopologyPort => ({
    name: 'branching-topology',
    kinds: ['parallel', 'sequence'],
    bind: (spec): BoundTopology => ({
      async run(input, scope) {
        const all: MemberResult[] = [];
        const call = async (id: string, path: string) => {
          const { result } = await scope.call(id, input, { node: path });
          all.push(result);
          return result;
        };
        const branch = async (b: Branch, path: string): Promise<MemberResult> => {
          if (typeof b === 'string') return call(b, path);
          let last: MemberResult = { status: 'completed', output: '' };
          for (const [i, step] of b.steps.entries()) {
            last = await call(step, `${path}.steps[${i}]`);
            if (last.status !== 'completed') break;
          }
          return last;
        };
        const branches = (spec as { branches: Branch[] }).branches;
        const results = await Promise.all(branches.map((b, i) => branch(b, `root.branches[${i}]`)));
        const tokens = all.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0);
        const base = results.find((r) => r.status !== 'completed') ?? { status: 'completed' as const, output: results.map((r) => r.output).join('|') };
        const { usage: _usage, ...rest } = base;
        return { ...rest, ...(tokens ? { usage: { inputTokens: tokens, outputTokens: 0 } } : {}) };
      },
    }),
  }),
}) as unknown as AdapterDescriptor;

const branching = { ports: { topology: { adapter: 'branching-topology' } }, extra: [branchingTopology] };

const alice = { id: 'alice', kind: 'user' as const, roles: ['staff'], scopes: ['orders'], credential: 'ALICE-CREDENTIAL' };
const mallory = { id: 'mallory', kind: 'user' as const, roles: [], scopes: [], credential: 'MALLORY-CREDENTIAL' };

test('resume by someone else than the run owner is denied before any reply is delivered; the owner can still resume', async () => {
  const { system, calls, journal } = await resumable({ billing: { ask: true } }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await system.run('secret of alice', { runId: 'own1', caller: alice })).status, 'waiting');
  const kept = journal.kept.get('own1')!;
  assert.deepEqual(kept.get('run:owner'), { id: 'alice', kind: 'user' });
  assert.ok(!JSON.stringify([...kept]).includes('ALICE-CREDENTIAL'));

  const stolen = await system.resume('own1', { input: 'reply of mallory' }, { caller: mallory });
  assert.deepEqual([stolen.status, stolen.reason?.code, stolen.reason?.layer, stolen.reason?.detail], ['stopped', 'denied', 'host', 'only the caller that started the run may resume it']);
  assert.equal(stolen.output, '');
  assert.deepEqual(stolen.record, []);
  assert.deepEqual([...(journal.signals.get('own1') ?? new Map()).keys()], [], 'no reply was delivered');
  assert.equal(journal.statuses.get('own1'), 'waiting');
  const anonymous = await system.resume('own1', { input: 'no one' });
  assert.equal(anonymous.reason?.code, 'denied');

  const res = await system.resume('own1', { input: 'reply of alice' }, { caller: { ...alice, credential: 'ANOTHER-TOKEN' } });
  assert.equal(res.status, 'completed', JSON.stringify(res.reason));
  assert.deepEqual(calls, ['invoke:billing', 'resume:billing:task-billing:reply of alice']);
});

test('the gate is asked resume with the owner, the waiting member and the resumer without credential; ask keeps the run waiting', async () => {
  const questions: GateQuestion[] = [];
  let effect: 'ask' | 'allow' = 'ask';
  const h = recordingHost({ allow: (q) => { questions.push(q); return q.action === 'resume' ? { effect, reason: 'second person' } : { effect: 'allow' }; } });
  const { system, journal } = await resumable({ triage: {}, billing: { ask: true } }, { kind: 'sequence', steps: ['triage', 'billing'] }, { host: h.host });
  assert.equal((await system.run('hi', { runId: 'own2', caller: alice, sessionId: 's1' })).status, 'waiting');
  const asked = await system.resume('own2', { input: 'x' }, { caller: mallory, sessionId: 's1' });
  assert.deepEqual([asked.status, asked.reason?.code, asked.reason?.layer, asked.reason?.detail], ['waiting', 'needs_input', 'host', 'second person']);
  const question = questions.at(-1)!;
  assert.equal(question.action, 'resume');
  assert.deepEqual({ ...question, member: question.member?.id }, {
    action: 'resume', runId: 'own2', sessionId: 's1', caller: { id: 'mallory', kind: 'user', roles: [], scopes: [] },
    owner: { id: 'alice', kind: 'user' }, member: 'billing',
  });
  assert.equal(journal.signals.get('own2')?.size ?? 0, 0);
  assert.equal(journal.statuses.get('own2'), 'waiting');
  effect = 'allow';
  assert.equal((await system.resume('own2', { input: 'x' }, { caller: mallory })).status, 'completed');
});

test('an approval kept for the next attempt records who gave it, and the gate sees it', async () => {
  const questions: GateQuestion[] = [];
  const { system, journal } = await resumable({ triage: {}, billing: {} }, { kind: 'sequence', steps: ['triage', 'billing'] }, { host: askingGate(questions).host });
  assert.equal((await system.run('hi', { runId: 'own3', caller: alice })).status, 'waiting');
  assert.equal((await system.resume('own3', { approved: true, reason: 'fine' }, { caller: boss })).status, 'completed');
  const resume = questions.find((q) => q.action === 'resume')!;
  assert.deepEqual(resume.answer, { approved: true, reason: 'fine', by: 'boss' });
  assert.deepEqual(journal.kept.get('own3')!.get('call:root.steps[1]:0:attempt'), { n: 1, answer: { approved: true, reason: 'fine', by: 'boss' } });
});

// Cancel ------------------------------------------------------------------------------------------------------------

test('cancel closes a waiting run: the member task is cancelled, the run ends stopped/cancelled, and neither resume nor run continues it', async () => {
  const h = recordingHost();
  const { system, calls, journal } = await resumable({ triage: {}, billing: { ask: true, cancel: true } }, { kind: 'sequence', steps: ['triage', 'billing'] }, { host: h.host });
  assert.equal((await system.run('hi', { runId: 'c1', caller: alice })).status, 'waiting');
  const res = await system.cancel('c1', { by: alice, reason: 'config changed' });
  assert.deepEqual([res.status, res.runId, res.reason?.code, res.reason?.layer, res.reason?.by, res.reason?.detail], ['stopped', 'c1', 'cancelled', 'execution', 'alice', 'config changed']);
  assert.deepEqual(calls, ['invoke:triage', 'invoke:billing', 'cancel:billing:task-billing']);
  const kept = journal.kept.get('c1')!;
  assert.deepEqual([kept.get('run:waiting'), kept.get('run:status'), journal.statuses.get('c1'), kept.get('call:root.steps[1]:0:task')], [null, 'stopped', 'stopped', null]);
  assert.equal((kept.get('run:cancelled') as { by: string }).by, 'alice');
  assert.ok(!JSON.stringify([...kept]).includes('ALICE-CREDENTIAL'));
  assert.deepEqual(h.events.find((e) => e.name === 'plexus.run.cancelled')?.attrs, {
    'plexus.layer': 'execution', 'plexus.system': 'support', 'plexus.run.id': 'c1', 'plexus.run.status': 'stopped', 'plexus.run.reason': 'cancelled', 'plexus.member': 'billing',
  });

  const resumed = await system.resume('c1', { input: 'late' }, { caller: alice });
  assert.deepEqual([resumed.status, resumed.reason?.code, resumed.reason?.layer, resumed.reason?.detail], ['failed', 'error', 'execution', 'run c1 was cancelled']);
  const rerun = await system.run('hi', { runId: 'c1', caller: alice });
  assert.deepEqual([rerun.status, rerun.reason?.detail], ['failed', 'run c1 was cancelled']);
  const again = await system.cancel('c1', { by: alice });
  assert.deepEqual([again.status, again.reason?.code, again.reason?.detail], ['stopped', 'cancelled', 'config changed']);
  assert.deepEqual(calls, ['invoke:triage', 'invoke:billing', 'cancel:billing:task-billing']);
});

test('cancel of a run unknown to the journal is refused not_found and leaves nothing behind', async () => {
  const { system, journal } = await resumable({ billing: {} }, { kind: 'sequence', steps: ['billing'] });
  const res = await system.cancel('nope');
  assert.deepEqual([res.status, res.runId, res.reason?.code, res.reason?.layer, res.reason?.detail], ['failed', 'nope', 'not_found', 'execution', 'run nope not found']);
  assert.equal(journal.statuses.get('nope'), 'failed');
  assert.deepEqual([(await system.cancel('')).reason?.detail, (await system.cancel('x'.repeat(200))).reason?.code], ['invalid run id', 'error']);
});

test('cancel by anyone but the owner is denied by the host and the run stays waiting; the owner cancels it', async () => {
  const { system, calls, journal } = await resumable({ billing: { ask: true, cancel: true } }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await system.run('hi', { runId: 'c2', caller: alice })).status, 'waiting');
  for (const by of [mallory, undefined]) {
    const denied = await system.cancel('c2', by ? { by } : {});
    assert.deepEqual([denied.status, denied.reason?.code, denied.reason?.layer, denied.reason?.detail], ['stopped', 'denied', 'host', 'only the caller that started the run may cancel it']);
  }
  assert.deepEqual([journal.statuses.get('c2'), journal.kept.get('c2')!.has('run:cancelled'), calls], ['waiting', false, ['invoke:billing']]);
  assert.equal((await system.resume('c2', { input: 'still open' }, { caller: alice })).status, 'completed');
});

test('the gate is asked cancel with the owner and the waiting member, never with a credential; ask keeps the run waiting', async () => {
  const questions: GateQuestion[] = [];
  let effect: 'ask' | 'allow' = 'ask';
  const h = recordingHost({ allow: (q) => { questions.push(q); return q.action === 'cancel' ? { effect, reason: 'second person' } : { effect: 'allow' }; } });
  const { system, journal } = await resumable({ billing: { ask: true } }, { kind: 'sequence', steps: ['billing'] }, { host: h.host });
  assert.equal((await system.run('hi', { runId: 'c3', caller: alice })).status, 'waiting');
  const asked = await system.cancel('c3', { by: mallory });
  assert.deepEqual([asked.status, asked.reason?.code, asked.reason?.layer, asked.reason?.detail], ['waiting', 'needs_input', 'host', 'second person']);
  const question = questions.at(-1)!;
  assert.deepEqual({ ...question, member: question.member?.id }, {
    action: 'cancel', runId: 'c3', caller: { id: 'mallory', kind: 'user', roles: [], scopes: [] }, owner: { id: 'alice', kind: 'user' }, member: 'billing',
  });
  assert.equal(journal.statuses.get('c3'), 'waiting');
  effect = 'allow';
  assert.equal((await system.cancel('c3', { by: mallory })).reason?.code, 'cancelled');
});

test('cancel of a run that is over is refused conflict; a failing member cancel is reported and the run is still cancelled', async () => {
  const done = await resumable({ billing: {} }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await done.system.run('hi', { runId: 'c4', caller: alice })).status, 'completed');
  const over = await done.system.cancel('c4', { by: alice });
  assert.deepEqual([over.status, over.reason?.code, over.reason?.detail], ['failed', 'conflict', 'run c4 is already completed']);
  assert.equal(done.journal.kept.get('c4')!.has('run:cancelled'), false);

  const h = recordingHost();
  const { system, calls } = await resumable({ billing: { ask: true, cancel: 'throws' } }, { kind: 'sequence', steps: ['billing'] }, { host: h.host });
  assert.equal((await system.run('hi', { runId: 'c5', caller: alice })).status, 'waiting');
  assert.equal((await system.cancel('c5', { by: alice })).reason?.code, 'cancelled');
  assert.deepEqual(calls, ['invoke:billing', 'cancel:billing:task-billing']);
  assert.ok(h.events.some((e) => e.name === 'plexus.member.cancel_failed'));
});

test('cancel of a run another invocation holds is refused as in progress; an aborted signal changes nothing', async () => {
  const { system, journal } = await resumable({ billing: { ask: true, slowResume: 40 } }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await system.run('hi', { runId: 'c6', caller: alice })).status, 'waiting');
  const aborted = AbortSignal.abort();
  const stopped = await system.cancel('c6', { by: alice, signal: aborted });
  assert.deepEqual([stopped.status, stopped.reason?.code], ['stopped', 'aborted']);
  assert.equal(journal.kept.get('c6')!.has('run:cancelled'), false);
  const resuming = system.resume('c6', { input: 'x' }, { caller: alice });
  await new Promise((done) => setTimeout(done, 10));
  assert.equal((await system.cancel('c6', { by: alice })).reason?.detail, 'run c6 is in progress');
  assert.equal((await resuming).status, 'completed');
});

test('run with the id of a known run: the owner continues it; anyone else asks the gate; a different input fails and is never kept', async () => {
  const { system, calls, journal } = await resumable({ triage: {}, billing: { ask: true } }, { kind: 'sequence', steps: ['triage', 'billing'] });
  assert.equal((await system.run('secret of alice', { runId: 'own4', caller: alice })).status, 'waiting');
  const other = await system.run('secret of alice', { runId: 'own4', caller: mallory });
  assert.deepEqual([other.status, other.reason?.code, other.reason?.layer], ['stopped', 'denied', 'host']);
  assert.deepEqual(other.record, []);
  const changed = await system.run('another input', { runId: 'own4', caller: alice });
  assert.deepEqual([changed.status, changed.reason?.code, changed.reason?.layer, changed.reason?.detail], ['failed', 'error', 'execution', 'run own4 exists with a different input']);
  assert.equal(journal.kept.get('own4')!.get('run:input'), 'secret of alice');
  assert.equal(journal.statuses.get('own4'), 'waiting');
  const again = await system.run({ text: 'secret of alice' }, { runId: 'own4', caller: alice });
  assert.deepEqual([again.status, again.reason?.code], ['waiting', 'needs_input']);
  assert.deepEqual(calls, ['invoke:triage', 'invoke:billing']);
});

test('parallel branches keep their step keys on replay: a resume continues the waiting call once and invokes nobody again', async () => {
  const { system, calls, journal } = await resumable(
    { A: { slow: 40 }, B: {}, C: {}, D: { ask: true } },
    { kind: 'parallel', branches: [{ kind: 'sequence', steps: ['A', 'B'] }, { kind: 'sequence', steps: ['C', 'D'] }] },
    branching,
  );
  const first = await system.run('hi', { runId: 'par1' });
  assert.equal(first.status, 'waiting');
  assert.deepEqual(journal.kept.get('par1')!.get('run:waiting'), { key: 'call:root.branches[1].steps[1]:0', attempt: 0, kind: 'member', member: 'D', node: 'root.branches[1].steps[1]' });
  const res = await system.resume('par1', { input: 'reply' });
  assert.equal(res.status, 'completed', JSON.stringify(res.reason));
  assert.deepEqual(calls.filter((c) => c.startsWith('invoke:')).sort(), ['invoke:A', 'invoke:B', 'invoke:C', 'invoke:D']);
  assert.deepEqual(calls.filter((c) => c.startsWith('resume:')), ['resume:D:task-D:reply']);
});

test('the same node path called twice gets one step key per call', async () => {
  const { system, journal } = await resumable({ triage: {} }, { kind: 'sequence', steps: ['triage', 'triage'] });
  assert.equal((await system.run('hi', { runId: 'twice' })).status, 'completed');
  assert.deepEqual(journal.steps.filter((k) => k.startsWith('call:')), ['call:root.steps[0]:0', 'call:root.steps[1]:0']);
  const same = defineAdapter({
    fills: 'TopologyPort', name: 'same-path', maps, tiers: both, portVersion: '0.1.0',
    create: (): TopologyPort => ({
      name: 'same-path', kinds: ['sequence'],
      bind: (): BoundTopology => ({
        async run(input, scope) {
          const one = (await scope.call('triage', input, { node: 'root' })).result;
          return (await scope.call('triage', one.output, { node: 'root' })).result;
        },
      }),
    }),
  }) as unknown as AdapterDescriptor;
  const again = await resumable({ triage: {} }, { kind: 'sequence', steps: ['triage'] }, { ports: { topology: { adapter: 'same-path' } }, extra: [same] });
  assert.equal((await again.system.run('hi', { runId: 'twice' })).output, 'triage:triage:hi');
  assert.deepEqual(again.journal.steps, ['call:root:0', 'call:root:1']);
});

test('a reply delivered by a resume that died before keeping its claim: the next resume continues with that reply', async () => {
  const h = recordingHost();
  const { system, calls, journal } = await resumable({ billing: { ask: true } }, { kind: 'sequence', steps: ['billing'] }, { host: h.host });
  assert.equal((await system.run('hi', { runId: 'claim1' })).status, 'waiting');
  // An earlier resume signalled the wait, then its process ended before it kept run:claimed.
  assert.equal(await journal.signal('claim1', 'call:root.steps[0]:0:reply:0', { input: 'first' }), true);
  const next = await system.resume('claim1', { input: 'second' });
  assert.deepEqual([next.status, next.output], ['completed', 'billing:first'], JSON.stringify(next.reason));
  assert.deepEqual(calls, ['invoke:billing', 'resume:billing:task-billing:first'], 'the first reply wins; the second is not used');
  assert.deepEqual(h.events.filter((e) => e.name === 'plexus.execution.reply_kept').map((e) => e.attrs['plexus.member']), ['billing']);
  assert.equal(journal.statuses.get('claim1'), 'completed');
});

test('a reply delivered but never claimed: a run with the same id also continues with it instead of waiting forever', async () => {
  const { system, calls, journal } = await resumable({ billing: { ask: true } }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await system.run('hi', { runId: 'claim3' })).status, 'waiting');
  await journal.signal('claim3', 'call:root.steps[0]:0:reply:0', { input: 'first' });
  const past = { deadlineAt: new Date(Date.now() - 1000).toISOString(), hops: 0, maxHops: 5 };
  assert.equal((await system.resume('claim3', { input: 'second' }, { bounds: past })).reason?.code, 'timeout');
  assert.deepEqual(journal.kept.get('claim3')!.get('run:claimed'), { key: 'call:root.steps[0]:0', attempt: 0, kind: 'member', member: 'billing', node: 'root.steps[0]' });
  const again = await system.run('hi', { runId: 'claim3' });
  assert.deepEqual([again.status, again.output], ['completed', 'billing:first']);
  assert.deepEqual(calls, ['invoke:billing', 'resume:billing:task-billing:first']);
});

test('a resume that claimed the reply but did not reach the call: a run with the same id continues with that reply', async () => {
  const { system, calls, journal } = await resumable({ billing: { ask: true } }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await system.run('hi', { runId: 'claim2' })).status, 'waiting');
  const past = { deadlineAt: new Date(Date.now() - 1000).toISOString(), hops: 0, maxHops: 5 };
  const cut = await system.resume('claim2', { input: 'kept reply' }, { bounds: past });
  assert.deepEqual([cut.status, cut.reason?.code], ['stopped', 'timeout']);
  const kept = journal.kept.get('claim2')!;
  assert.equal(kept.get('run:waiting'), null);
  assert.equal((await system.resume('claim2', { input: 'other' })).reason?.detail, 'run claim2 is not waiting');
  const res = await system.run('hi', { runId: 'claim2' });
  assert.equal(res.status, 'completed', JSON.stringify(res.reason));
  assert.deepEqual(calls, ['invoke:billing', 'resume:billing:task-billing:kept reply']);
});

test('a member that throws is not journaled: a resume calls it again, while the waiting branch continues', async () => {
  const { system, calls } = await resumable({ D: { ask: true }, E: { flaky: true } }, { kind: 'parallel', branches: ['D', 'E'] }, branching);
  const first = await system.run('hi', { runId: 'flaky1' });
  assert.equal(first.status, 'waiting');
  assert.deepEqual(first.record.map((h) => [h.member, h.status]).sort(), [['D', 'waiting'], ['E', 'failed']]);
  const res = await system.resume('flaky1', { input: 'ok' });
  assert.equal(res.status, 'completed', JSON.stringify(res.reason));
  assert.deepEqual(calls.slice(0, 2), ['invoke:D', 'invoke:E']);
  assert.deepEqual(calls.slice(2).sort(), ['invoke:E', 'resume:D:task-D:ok']);
  assert.deepEqual(res.record.map((h) => [h.member, h.status, h.replayed]).sort(), [['D', 'completed', undefined], ['E', 'completed', undefined]]);
});

test('replayed hops are marked and their usage is not counted again in the resumed result', async () => {
  const { system } = await resumable({ triage: { tokens: 50 }, billing: { tokens: 7 } }, { kind: 'parallel', branches: ['triage', 'billing'] }, { ...branching, host: askingGate().host });
  const first = await system.run('hi', { runId: 'used1' });
  assert.equal(first.status, 'waiting');
  assert.deepEqual(first.usage, { inputTokens: 50, outputTokens: 0 });
  const res = await system.resume('used1', { approved: true });
  assert.equal(res.status, 'completed', JSON.stringify(res.reason));
  assert.deepEqual(res.usage, { inputTokens: 7, outputTokens: 0 });
  const triage = res.record.find((h) => h.member === 'triage')!;
  assert.deepEqual([triage.replayed, triage.usage], [true, { inputTokens: 50, outputTokens: 0 }]);
  assert.equal(res.record.find((h) => h.member === 'billing')!.replayed, undefined);
});

test('a router that throws is a failed routing hop, even on an optional route, and its failure is not journaled', async () => {
  let down = true;
  const flaky = defineAdapter({
    fills: 'AgentRouterPort', name: 'flaky-router', maps, tiers: both, portVersion: '0.1.0',
    create: (): AgentRouterPort => ({ name: 'flaky-router', route: async (q) => { if (down) throw new Error('router down'); return { member: q.candidates[0]!.id }; } }),
  }) as unknown as AdapterDescriptor;
  const decisions: RouteDecision[] = [];
  const probing = defineAdapter({
    fills: 'TopologyPort', name: 'optional-route', maps, tiers: both, portVersion: '0.1.0',
    create: (): TopologyPort => ({
      name: 'optional-route', kinds: ['sequence'],
      bind: (): BoundTopology => ({
        async run(input, scope) {
          const decision = await scope.route({ input, candidates: ['billing'], node: 'root.turns[1]', optional: true });
          decisions.push(decision);
          return decision.member ? (await scope.call(decision.member, input, { node: 'root.turns[1]' })).result : { status: 'failed', output: '', reason: { code: 'error', layer: 'routing' } };
        },
      }),
    }),
  }) as unknown as AdapterDescriptor;
  const { system } = await resumable({ billing: {} }, { kind: 'sequence', steps: ['billing'] }, {
    ports: { router: { adapter: 'flaky-router' }, topology: { adapter: 'optional-route' } }, extra: [flaky, probing],
  });
  const res = await system.run('hi', { runId: 'route1' });
  assert.deepEqual(decisions[0], { reason: 'router down', failed: true });
  assert.deepEqual(res.record.map((h) => [h.member, h.status, h.reason?.code, h.reason?.layer, h.reason?.detail]), [['', 'failed', 'error', 'routing', 'router down']]);
  down = false;
  const again = await system.run('hi', { runId: 'route1' });
  assert.equal(again.status, 'completed', JSON.stringify(again.reason));
  assert.equal(again.output, 'billing:hi');
});

test('a failed write of a run value is reported as plexus.execution.write_failed with the key, never the value', async () => {
  const h = recordingHost();
  const { system, journal } = await resumable({ triage: {} }, { kind: 'sequence', steps: ['triage'] }, { host: h.host });
  const begin = journal.begin.bind(journal);
  journal.begin = async (key) => {
    const run = await begin(key);
    return { ...run, remember: async (k, v) => { if (k === 'run:status') throw new Error('disk full'); return run.remember(k, v); } };
  };
  assert.equal((await system.run('the secret input', { runId: 'w1' })).status, 'completed');
  const failedWrites = h.events.filter((e) => e.name === 'plexus.execution.write_failed');
  assert.deepEqual(failedWrites.map((e) => [e.attrs['plexus.execution.key'], e.attrs['plexus.error.message'], e.attrs['plexus.layer']]), [['run:status', 'disk full', 'execution']]);
  assert.ok(!JSON.stringify(failedWrites).includes('the secret input'));
});

test('a failed end of the run and a failed keep of a waiting member\'s handle are reported as write_failed', async () => {
  const h = recordingHost();
  const { system, journal } = await resumable({ billing: { ask: true } }, { kind: 'sequence', steps: ['billing'] }, { host: h.host });
  const begin = journal.begin.bind(journal);
  journal.begin = async (key) => {
    const run = await begin(key);
    return {
      ...run,
      remember: async (k, v) => { if (k.endsWith(':task')) throw new Error('disk full'); return run.remember(k, v); },
      end: async () => { throw new Error('disk gone'); },
    };
  };
  assert.equal((await system.run('hi', { runId: 'w2' })).status, 'waiting', 'the result stands');
  const failedWrites = h.events.filter((e) => e.name === 'plexus.execution.write_failed');
  assert.deepEqual(failedWrites.map((e) => [e.attrs['plexus.execution.key'], e.attrs['plexus.error.message']]), [['call:root.steps[0]:0:task', 'disk full'], ['end', 'disk gone']]);
});

// One invocation per run ---------------------------------------------------------------------------------------------

const tick = (ms = 10) => new Promise((done) => setTimeout(done, ms));

test('a run or resume of a run another invocation holds fails as in progress and touches nothing', async () => {
  const { system, calls, journal } = await resumable({ billing: { ask: true, slowResume: 40 } }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await system.run('hi', { runId: 'busy1', caller: alice })).status, 'waiting');
  const begun: string[] = [];
  const begin = journal.begin.bind(journal);
  journal.begin = async (key) => { begun.push(key); return begin(key); };
  const first = system.resume('busy1', { input: 'one' }, { caller: alice });
  await tick();
  const inProgress = ['failed', 'error', 'execution', 'run busy1 is in progress'];
  const second = await system.resume('busy1', { input: 'two' }, { caller: alice });
  assert.deepEqual([second.status, second.reason?.code, second.reason?.layer, second.reason?.detail], inProgress);
  const denied = await system.resume('busy1', { input: 'evil' }, { caller: mallory });
  assert.deepEqual([denied.status, denied.reason?.code, denied.reason?.layer, denied.reason?.detail], inProgress);
  const rerun = await system.run('hi', { runId: 'busy1', caller: alice });
  assert.deepEqual([rerun.status, rerun.reason?.detail, rerun.record], ['failed', 'run busy1 is in progress', []]);
  assert.deepEqual(begun, ['busy1'], 'the refused invocations never began the run');
  assert.equal(journal.signals.get('busy1')?.size, 1);
  const done = await first;
  assert.deepEqual([done.status, done.output], ['completed', 'billing:one']);
  assert.equal(journal.statuses.get('busy1'), 'completed');
  assert.deepEqual(calls, ['invoke:billing', 'resume:billing:task-billing:one']);
  // Once it let go, the run can be invoked again.
  assert.equal((await system.run('hi', { runId: 'busy1', caller: alice })).status, 'completed');
});

test('systems that share one journal instance share the hold on its runs', async () => {
  const calls: string[] = [];
  const journal = memoryExecution([], true);
  const one = async () => (await build(
    { members: { billing: { adapter: 'asking-member', options: { ask: true, slowResume: 40 } } }, topology: { kind: 'sequence', steps: ['billing'] }, ports: { ...rawConfig().ports, execution: { adapter: 'durable-execution' } } },
    { extra: [askingMember(calls), durableExecution(journal)] },
  )).system;
  const [a, b] = [await one(), await one()];
  assert.equal((await a.run('hi', { runId: 'shared1' })).status, 'waiting');
  const first = a.resume('shared1', { input: 'one' });
  await tick();
  assert.equal((await b.resume('shared1', { input: 'two' })).reason?.detail, 'run shared1 is in progress');
  assert.equal((await first).status, 'completed');
});

test('a begin the journal refuses with RUN_BUSY fails as in progress and is not let go of', async () => {
  const { system, journal } = await resumable({ billing: { ask: true } }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await system.run('hi', { runId: 'busy2' })).status, 'waiting');
  journal.begin = async (key) => { throw new RunBusyError(key); };
  const res = await system.resume('busy2', { input: 'x' });
  assert.deepEqual([res.status, res.reason?.code, res.reason?.layer, res.reason?.detail], ['failed', 'error', 'execution', 'run busy2 is in progress']);
  journal.begin = async () => { throw Object.assign(new Error('locked elsewhere'), { code: 'RUN_BUSY' }); };
  assert.equal((await system.run('hi', { runId: 'busy2' })).reason?.detail, 'run busy2 is in progress');
  assert.deepEqual(journal.released, []);
  assert.equal(journal.statuses.get('busy2'), 'waiting');
});

test('a refused invocation lets go of the run without a status; one that kept nothing ends failed', async () => {
  const { system, journal } = await resumable({ billing: { ask: true } }, { kind: 'sequence', steps: ['billing'] });
  assert.equal((await system.run('hi', { runId: 'let1', caller: alice })).status, 'waiting');
  assert.equal((await system.resume('let1', { input: 'x' }, { caller: mallory })).reason?.code, 'denied');
  assert.equal((await system.run('other', { runId: 'let1', caller: alice })).reason?.detail, 'run let1 exists with a different input');
  assert.deepEqual(journal.released, ['let1', 'let1']);
  assert.equal(journal.statuses.get('let1'), 'waiting');
  await system.resume('never', { input: 'x' });
  assert.equal(journal.statuses.get('never'), 'failed');
  assert.deepEqual(journal.released, ['let1', 'let1']);
});

// The wait a result reports ------------------------------------------------------------------------------------------

/** A topology that goes on past a wait: X, then Y when X waits; the result is Y's. */
const pastWait = defineAdapter({
  fills: 'TopologyPort', name: 'past-wait', maps, tiers: both, portVersion: '0.1.0',
  create: (): TopologyPort => ({
    name: 'past-wait', kinds: ['sequence'],
    bind: (): BoundTopology => ({
      async run(input, scope) {
        const x = (await scope.call('X', input, { node: 'root.x' })).result;
        return x.status === 'waiting' ? (await scope.call('Y', input, { node: 'root.y' })).result : x;
      },
    }),
  }),
}) as unknown as AdapterDescriptor;

/** A topology that calls D and G at once and returns the first that did not complete in that order, else both outputs. */
const bothAtOnce = defineAdapter({
  fills: 'TopologyPort', name: 'both-at-once', maps, tiers: both, portVersion: '0.1.0',
  create: (): TopologyPort => ({
    name: 'both-at-once', kinds: ['parallel'],
    bind: (): BoundTopology => ({
      async run(input, scope) {
        const results = (await Promise.all([scope.call('D', input, { node: 'root.d' }), scope.call('G', input, { node: 'root.g' })])).map((o) => o.result);
        return results.find((r) => r.status !== 'completed') ?? { status: 'completed', output: results.map((r) => r.output).join('+') };
      },
    }),
  }),
}) as unknown as AdapterDescriptor;

test('a run that went past a wait to a second one keeps the wait its result reports; the resume answers that one', async () => {
  const { system, calls, journal } = await resumable({ X: { ask: true }, Y: { ask: true } }, { kind: 'sequence', steps: ['X', 'Y'] }, {
    ports: { topology: { adapter: 'past-wait' } }, extra: [pastWait],
  });
  const first = await system.run('hi', { runId: 'past1' });
  assert.equal(first.status, 'waiting');
  assert.deepEqual(first.wait, { token: 'call:root.y:0#0', kind: 'input', member: 'Y' });
  assert.equal((journal.kept.get('past1')!.get('run:waiting') as { member: string }).member, 'Y');
  const res = await system.resume('past1', { input: 'for-Y', wait: first.wait!.token });
  assert.deepEqual([res.status, res.output, res.wait], ['completed', 'Y:for-Y', undefined], JSON.stringify(res.reason));
  assert.deepEqual(calls, ['invoke:X', 'invoke:Y', 'resume:Y:task-Y:for-Y']);
});

test('a member wait and a gate ask at once: the result, the kept wait and the reply agree; a stale or wrong wait token is refused', async () => {
  const h = recordingHost({
    allow: (q) => (q.action === 'invoke' && q.member.id === 'G' && !q.answer ? { effect: 'ask', reason: 'approve G' } : { effect: 'allow' }),
  });
  const { system, calls, journal } = await resumable({ D: { ask: true, slow: 30 }, G: {} }, { kind: 'parallel', branches: ['D', 'G'] }, {
    host: h.host, ports: { topology: { adapter: 'both-at-once' } }, extra: [bothAtOnce],
  });
  const first = await system.run('hi', { runId: 'par2' });
  assert.deepEqual([first.status, first.reason?.layer, first.wait], ['waiting', 'member', { token: 'call:root.d:0#0', kind: 'input', member: 'D' }]);
  assert.deepEqual(journal.kept.get('par2')!.get('run:waiting'), { key: 'call:root.d:0', attempt: 0, kind: 'member', member: 'D', node: 'root.d' });

  const wrong = await system.resume('par2', { input: 'x', wait: 'call:root.g:0#0' });
  assert.deepEqual([wrong.status, wrong.reason?.code, wrong.reason?.layer, wrong.reason?.detail], ['failed', 'error', 'execution', 'run par2 waits on another step']);
  assert.equal(journal.signals.get('par2')?.size ?? 0, 0, 'no reply was delivered');
  assert.match((await system.resume('par2', { input: 'x', wait: 7 } as never)).reason?.detail ?? '', /invalid reply/);

  const second = await system.resume('par2', { input: 'for-D', wait: first.wait!.token });
  assert.deepEqual([second.status, second.reason?.layer, second.wait], ['waiting', 'host', { token: 'call:root.g:0#0', kind: 'approval', member: 'G' }]);
  // The first reply again, delayed or repeated: it names a wait the run no longer has.
  assert.equal((await system.resume('par2', { input: 'for-D', wait: first.wait!.token })).reason?.detail, 'run par2 waits on another step');
  const done = await system.resume('par2', { approved: true, wait: second.wait!.token });
  assert.deepEqual([done.status, done.output], ['completed', 'D:for-D+G:hi'], JSON.stringify(done.reason));
  assert.deepEqual(calls.filter((c) => c.startsWith('resume:')), ['resume:D:task-D:for-D']);
});

test('a member cannot name a wait; a waiting result without one keeps the latest wait, reported', async () => {
  const h = recordingHost();
  const forged = defineAdapter({
    fills: 'TopologyPort', name: 'forged', maps, tiers: both, portVersion: '0.1.0',
    create: (): TopologyPort => ({
      name: 'forged', kinds: ['sequence'],
      bind: (): BoundTopology => ({
        async run(input, scope) {
          const { wait: _wait, ...result } = (await scope.call('X', input, { node: 'root' })).result;
          return result;
        },
      }),
    }),
  }) as unknown as AdapterDescriptor;
  const naming = defineAdapter({
    fills: 'MemberPort', name: 'naming-member', maps, tiers: both, portVersion: '0.1.0',
    create: (_o, ctx): MemberPort => fakeMemberPort(ctx.name, async () => ({ status: 'waiting', output: '', reason: { code: 'needs_input', layer: 'member' }, taskRef: 't', wait: { token: 'mine', kind: 'approval', member: 'Z' } }) as MemberResult),
  }) as unknown as AdapterDescriptor;
  const built = await build(
    { members: { X: { adapter: 'naming-member' } }, topology: { kind: 'sequence', steps: ['X'] }, ports: { ...rawConfig().ports, topology: { adapter: 'forged' }, execution: { adapter: 'durable-execution' } } },
    { host: h.host, extra: [forged, naming, durableExecution(memoryExecution([], true))] },
  );
  const res = await built.system.run('hi', { runId: 'forged1' });
  assert.deepEqual([res.status, res.wait], ['waiting', { token: 'call:root:0#0', kind: 'input', member: 'X' }]);
  assert.deepEqual(h.events.filter((e) => e.name === 'plexus.execution.wait_inferred').map((e) => e.attrs['plexus.member']), ['X']);
});

// A run that cannot keep its owner or input does not start -------------------------------------------------------------

test('a run whose owner or input cannot be kept fails before its topology runs; nobody can replay it later', async () => {
  for (const key of ['run:owner', 'run:input']) {
    const h = recordingHost();
    const { system, calls, journal } = await resumable({ A: {}, B: { ask: true } }, { kind: 'sequence', steps: ['A', 'B'] }, { host: h.host });
    const begin = journal.begin.bind(journal);
    let failing = true;
    journal.begin = async (k) => {
      const run = await begin(k);
      return { ...run, remember: async (name, v) => { if (failing && name === key) throw new Error('SQLITE_BUSY'); return run.remember(name, v); } };
    };
    const res = await system.run('secret of alice', { runId: 'own9', caller: alice });
    assert.deepEqual([res.status, res.reason?.code, res.reason?.layer, res.reason?.detail, res.record], ['failed', 'error', 'execution', 'run own9 could not be kept', []], key);
    assert.deepEqual(calls, [], `${key}: the topology never ran`);
    assert.equal(journal.statuses.get('own9'), 'failed');
    assert.deepEqual(h.events.filter((e) => e.name === 'plexus.execution.write_failed').map((e) => e.attrs['plexus.execution.key']), [key]);
    failing = false;
    const again = await system.run('secret of alice', { runId: 'own9', caller: alice });
    assert.equal(again.status, 'waiting', key);
    assert.equal(journal.kept.get('own9')!.get('run:input'), 'secret of alice');
    assert.deepEqual(calls, ['invoke:A', 'invoke:B']);
  }
});

test('usage and cost of a result are the core\'s totals over the calls of this invocation, whatever the topology returns', async () => {
  const liar = defineAdapter({
    fills: 'TopologyPort', name: 'liar-topology', maps, tiers: both, portVersion: '0.1.0',
    create: (): TopologyPort => ({
      name: 'liar-topology', kinds: ['sequence'],
      bind: () => ({
        async run(input, scope) {
          await scope.call('triage', input, { node: 'root.steps[0]' });
          await scope.call('billing', input, { node: 'root.steps[1]' });
          return { status: 'completed', output: 'done', usage: { inputTokens: 999, outputTokens: 999 }, costUsd: 42 };
        },
      }),
    }),
  }) as unknown as AdapterDescriptor;
  const { system } = await build({
    members: { triage: { adapter: 'fake-member', options: { reply: 'T', tokens: 5 } }, billing: { adapter: 'fake-member', options: { reply: 'B', tokens: 7 } } },
    ports: { ...rawConfig().ports, topology: { adapter: 'liar-topology' } },
  }, { extra: [liar] });
  const res = await system.run('hi');
  assert.deepEqual(res.usage, { inputTokens: 12, outputTokens: 0 });
  assert.equal(res.costUsd, undefined);
});

test('without a host scorer the built-in expected checks apply, so a case is never passed unchecked', async () => {
  const { system } = await build({}, { host: recordingHost().host });
  const res = await system.run('hi');
  const scores = await system.score({ id: 'c', input: 'hi', expected: { output: { equals: 'nope' }, members: { triage: { contains: 'T:hi' } } } }, res);
  assert.deepEqual(scores.map((s) => [s.metric, s.value]), [['expected.output', 0], ['expected.member', 1]]);
});

test('a host scorer gets read, so it can check member outputs', async () => {
  const harness = recordingHost();
  const texts: (string | undefined)[] = [];
  harness.host.score = {
    async score(_c, result, ctx) {
      texts.push(await ctx?.read?.(result.record[0]!.outputRef!));
      return [{ metric: 'own', value: 1 }];
    },
  };
  const { system } = await build({}, { host: harness.host });
  const res = await system.run('hi');
  assert.deepEqual(await system.score({ id: 'c', input: 'hi' }, res), [{ metric: 'own', value: 1 }]);
  assert.deepEqual(texts, ['triage:T:hi']);
});

test('abandoning a call that waits on a remote task asks its member to cancel the task', async () => {
  const cancelled: string[] = [];
  const waiter = defineAdapter({
    fills: 'MemberPort', name: 'waiting-member', maps, tiers: both, portVersion: '0.1.0',
    create: (_o, ctx): MemberPort => ({
      ...fakeMemberPort(ctx.name, async () => ({ status: 'waiting', output: '', reason: { code: 'needs_input' }, taskRef: `task-${ctx.name}` })),
      cancel: async (ref) => { cancelled.push(ref); },
    }),
  }) as unknown as AdapterDescriptor;
  const abandoning = defineAdapter({
    fills: 'TopologyPort', name: 'abandoning-topology', maps, tiers: both, portVersion: '0.1.0',
    create: (): TopologyPort => ({
      name: 'abandoning-topology', kinds: ['sequence'],
      bind: () => ({
        async run(input, scope) {
          const lost = await scope.call('triage', input, { node: 'root.branches[0]' });
          await scope.call('billing', input, { node: 'root.branches[1]' });
          scope.abandon(lost.hopId);
          scope.abandon(lost.hopId);
          return { status: 'completed', output: 'done' };
        },
      }),
    }),
  }) as unknown as AdapterDescriptor;
  const { system } = await build({
    members: { triage: { adapter: 'waiting-member' }, billing: { adapter: 'waiting-member' } },
    ports: { ...rawConfig().ports, topology: { adapter: 'abandoning-topology' } },
  }, { extra: [waiter, abandoning] });
  const res = await system.run('hi');
  await new Promise((done) => setImmediate(done));
  assert.equal(res.status, 'completed');
  assert.deepEqual(cancelled, ['task-triage']);
  assert.equal(res.record.find((h) => h.member === 'triage')?.abandoned, true);
});

test('a config with plugins loads its adapters from the plugin modules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-assemble-plugins-'));
  try {
    await writeFile(join(dir, 'plugin.mjs'), `
const base = { maps: { technology: 'test' }, portVersion: '0.1.0', tiers: ['prototype'] };
const entry = (id) => ({ id, name: id, description: id, skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: false } });
export const member = { ...base, fills: 'MemberPort', name: 'plugin-member', create: (o, ctx) => ({
  name: ctx.name, describe: async () => entry(ctx.name), invoke: async (input) => ({ status: 'completed', output: 'plugin:' + (typeof input === 'string' ? input : input.text) }),
}) };
export const topology = { ...base, fills: 'TopologyPort', name: 'plugin-topology', create: () => ({
  name: 'plugin-topology', kinds: ['sequence'],
  bind: (spec) => ({ run: async (input, scope) => (await scope.call(spec.steps[0], input, { node: 'root.steps[0]' })).result }),
}) };
export const execution = { ...base, fills: 'ExecutionPort', name: 'plugin-execution', create: () => {
  const texts = new Map();
  return {
    name: 'plugin-execution',
    begin: async (runKey) => {
      const kept = new Map();
      return { runKey, step: async (n, fn) => fn(), wait: async () => undefined, put: async (t) => { texts.set('t' + texts.size, t); return 't' + (texts.size - 1); },
        remember: async (k, v) => { kept.set(k, v); }, recall: async (k) => kept.get(k), end: async () => {} };
    },
    signal: async () => true,
    read: async (k) => texts.get(k),
  };
} };
export const attribution = { ...base, fills: 'AttributionPort', name: 'plugin-attribution', create: () => ({ name: 'plugin-attribution', attribute: async () => [] }) };
`);
    const config = resolveConfig({
      system: { name: 'plugged' },
      plugins: ['./plugin.mjs'],
      members: { solo: { adapter: 'plugin-member' } },
      ports: { topology: { adapter: 'plugin-topology' }, execution: { adapter: 'plugin-execution' }, attribution: { adapter: 'plugin-attribution' } },
      topology: { kind: 'sequence', steps: ['solo'] },
    }, { cwd: dir });
    const system = await assemble(config, { host: prototypeHost({ quiet: true }) });
    const res = await system.run('hi');
    assert.deepEqual([res.status, res.output], ['completed', 'plugin:hi']);
    await system.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
