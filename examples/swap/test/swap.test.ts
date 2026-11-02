import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assemble, loadConfig, loadDescriptor, prototypeHost, resolveConfig,
  type Attribution, type EvalCase, type Fills, type Host, type MemberResult, type ResolvedConfig, type RouteDecision, type RunScope, type System,
  type SystemResult, type TopologySpec,
} from '@agent-plexus/core';
import { adapters as fileExecution, createFileExecution } from '../adapters/file-execution.ts';
import { createLinearTopology } from '../adapters/linear-topology.ts';
import { answer as billingAnswer } from '../members/billing.ts';
import { startFakeAgent, type FakeAgent } from './a2a-fake.ts';

const here = (name: string): string => fileURLToPath(new URL(`../${name}`, import.meta.url));
const CONFIG = here('plexus.json');
const CASES = JSON.parse(readFileSync(here('cases.json'), 'utf8')) as EvalCase[];

/** One cell of the swap matrix (cells.json): a profile, and what is run against it. */
interface Cell {
  id: string;
  layer: string;
  profile: string | null;
  /** `cases`: the three cases; `wait`: a run that waits on the gate, then `System.resume`; `check-fails`: check refuses it. */
  run: 'cases' | 'wait' | 'check-fails';
  /** For `wait`: resume from a new system on the same journal, as after a restart. */
  restart?: boolean;
  cli: boolean;
  description: string;
}
const CELLS = JSON.parse(readFileSync(here('cells.json'), 'utf8')) as Cell[];

/** The base profile (undefined) and what each swap profile changes: the unit of the resolved config and the adapter now in it. */
const SWAPS = {
  'swap-registry': { unit: 'ports.registry', adapter: 'file-registry', fills: 'RegistryPort' },
  'swap-routing': { unit: 'ports.router', adapter: 'keyword-router', fills: 'AgentRouterPort' },
  'swap-topology': { unit: 'ports.topology', adapter: 'linear-topology', fills: 'TopologyPort' },
  'swap-execution': { unit: 'ports.execution', adapter: 'file-execution', fills: 'ExecutionPort' },
  'swap-attribution': { unit: 'ports.attribution', adapter: 'last-failure-attribution', fills: 'AttributionPort' },
} as const satisfies Record<string, { unit: string; adapter: string; fills: Fills }>;

/**
 * The stop code of the billing hop in the crash case. The agent-layers billing agent stops on "crash" through a guard of its own stack;
 * triage only restated the caller's input, so the block is traced to the input and the billing hop is named, as in every profile.
 * The A2A agent rejects the task.
 */
const CRASH_CODE: Record<string, string> = { 'swap-member-agent-layers': 'guard_block', 'swap-member-a2a': 'rejected' };
const BASE_CODE = 'error';

const caseOf = (id: string): EvalCase => {
  const found = CASES.find((c) => c.id === id);
  assert.ok(found, `case ${id} is in cases.json`);
  return found;
};

/** A system with the given host, else the host of its config, else the quiet prototype host. */
function assembleWith(config: ResolvedConfig, env: Env = process.env, host?: Host): Promise<System> {
  return assemble(config, { env, ...(host ? { host } : config.host ? {} : { host: prototypeHost({ quiet: true }) }) });
}

type Env = Record<string, string | undefined>;

/**
 * What a profile needs around it: a temp directory whose `journal.db` is SWAP_SQLITE_PATH, and for `swap-member-a2a` a
 * fake A2A billing agent on loopback that answers as `members/billing.ts` does and rejects the crash, at SWAP_BILLING_A2A_URL.
 */
async function fixture(profile: string | undefined): Promise<{ env: Env; dir: string; agent?: FakeAgent; close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'swap-test-'));
  const env: Env = { ...process.env, SWAP_SQLITE_PATH: join(dir, 'journal.db') };
  const agent = profile === 'swap-member-a2a'
    ? await startFakeAgent((text) => {
      const result = billingAnswer(text);
      return typeof result === 'string' ? { completed: result } : { rejected: true };
    }, { name: 'Billing agent', description: 'Answers invoice, refund and charge questions', tags: ['billing'] })
    : undefined;
  if (agent) env.SWAP_BILLING_A2A_URL = agent.cardUrl;
  return {
    env,
    dir,
    ...(agent ? { agent } : {}),
    close: async () => {
      await agent?.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Runs one case the way `eval` does: run, score, and attribute when it did not pass. */
async function evaluate(s: System, evalCase: EvalCase): Promise<{ passed: boolean; result: SystemResult; attributions: Attribution[] }> {
  const result = await s.run(evalCase.input);
  const scores = await s.score(evalCase, result);
  const passed = result.status === 'completed' && scores.every((x) => x.value >= 1);
  return { passed, result, attributions: passed ? [] : await s.attribute(result, scores) };
}

/** Runs `fn` on the system of a profile, with its fixture, and closes both. */
async function withSystem<T>(profile: string | undefined, fn: (s: System) => Promise<T>): Promise<T> {
  const around = await fixture(profile);
  try {
    const s = await assembleWith(await loadConfig(CONFIG, profile ? { profile } : {}), around.env);
    try {
      return await fn(s);
    } finally {
      await s.close();
    }
  } finally {
    await around.close();
  }
}

const members = (result: SystemResult): string[] => result.record.map((h) => h.member);

/** The three cases against the profile of a cell: the test names start with `cell <id>:`, which the swap matrix selects. */
function casesCell(id: string, profile: string | undefined): void {
  test(`cell ${id}: check has no FAIL`, async () => {
    const failures = await withSystem(profile, async (s) => (await s.check()).filter((f) => f.severity === 'fail'));
    assert.deepEqual(failures, []);
  });

  test(`cell ${id}: the billing and product cases complete and route like the base`, async () => {
    await withSystem(profile, async (s) => {
      const billing = await evaluate(s, caseOf('billing-refund'));
      assert.equal(billing.passed, true);
      assert.deepEqual(members(billing.result), ['triage', 'billing']);
      const product = await evaluate(s, caseOf('product-setup'));
      assert.equal(product.passed, true);
      assert.deepEqual(members(product.result), ['triage', 'manuals']);
    });
  });

  test(`cell ${id}: the crash case fails and attribution names member billing`, async () => {
    const code = CRASH_CODE[profile ?? ''] ?? BASE_CODE;
    await withSystem(profile, async (s) => {
      const crash = await evaluate(s, caseOf('billing-crash'));
      assert.equal(crash.passed, false);
      assert.equal(crash.result.status, 'stopped');
      const billing = crash.result.record.find((h) => h.member === 'billing');
      assert.equal(billing?.status, 'stopped');
      assert.equal(billing?.reason?.code, code);
      assert.ok(crash.attributions.length > 0, 'a failed run is attributed');
      assert.equal(crash.attributions[0]?.member, 'billing');
      assert.equal(crash.attributions[0]?.hopId, billing?.hopId);
    });
  });
}

/** A host whose gate asks before `billing` until the call is approved; a resume is the prototype host's. */
function askingHost(): Host {
  const host = prototypeHost({ quiet: true });
  return {
    ...host,
    gate: {
      ...host.gate,
      allow: async (q) => {
        if (q.action === 'resume') return host.gate.allow(q);
        if (q.member.id !== 'billing') return { effect: 'allow' };
        if (!q.answer) return { effect: 'ask', reason: 'approval pending' };
        return q.answer.approved ? { effect: 'allow' } : { effect: 'deny', reason: 'refused' };
      },
    },
  };
}

/**
 * A run of the billing case waits on the gate before billing; `System.resume` approves it, from the same system or, with
 * `restart`, from a new system on the same journal. The file journal of `swap-execution` is given a directory that
 * outlives one system (its default is a temp directory removed on close).
 */
function waitCell(id: string, profile: string | undefined, restart: boolean): void {
  test(`cell ${id}: a run that waits on the gate is resumed${restart ? ' by a new system on the same journal' : ''} and completes`, async () => {
    const around = await fixture(profile);
    const raw = JSON.parse(readFileSync(CONFIG, 'utf8')) as { profiles: Record<string, { ports?: { execution?: { options?: unknown } } }> };
    const execution = profile ? raw.profiles[profile]?.ports?.execution : undefined;
    if (execution && profile === 'swap-execution') execution.options = { dir: join(around.dir, 'journal') };
    const config = resolveConfig(raw, { cwd: dirname(CONFIG), ...(profile ? { profile } : {}) });
    const runId = `wait-${id}`;
    let s = await assembleWith(config, around.env, askingHost());
    try {
      const started = await s.run(caseOf('billing-refund').input, { runId });
      assert.deepEqual([started.status, started.reason?.code, started.reason?.layer], ['waiting', 'needs_input', 'host']);
      assert.deepEqual(members(started).filter((m) => m === 'triage'), ['triage']);
      if (restart) {
        await s.close();
        s = await assembleWith(config, around.env, askingHost());
      }
      const resumed = await s.resume(runId, { approved: true });
      assert.equal(resumed.status, 'completed', JSON.stringify(resumed.reason));
      assert.match(resumed.output, /refunds are issued/);
      const triage = resumed.record.filter((h) => h.member === 'triage');
      assert.equal(triage.length, 1, 'triage is called once');
      assert.equal(triage[0]?.replayed, true, 'the completed triage step replays from the journal');
      assert.equal(resumed.record.find((h) => h.member === 'billing')?.status, 'completed');
    } finally {
      await s.close();
      await around.close();
    }
  });
}

/** A profile whose topology the adapter cannot run is refused by check. */
function checkFailsCell(id: string, profile: string | undefined): void {
  test(`cell ${id}: a topology kind the adapter cannot run fails check with a clear finding`, async () => {
    const failures = await withSystem(profile, async (s) => (await s.check()).filter((f) => f.severity === 'fail'));
    const kind = failures.find((f) => /kind "loop" is not supported by the topology adapter/.test(f.message));
    assert.ok(kind, `a finding names the kind (got: ${failures.map((f) => f.message).join('; ')})`);
    assert.equal(kind.path, '$.topology');
    assert.equal(failures.length, 1, 'the bind failure the finding explains is not reported twice');
  });
}

for (const cell of CELLS) {
  const profile = cell.profile ?? undefined;
  if (cell.run === 'cases') casesCell(cell.id, profile);
  else if (cell.run === 'wait') waitCell(cell.id, profile, cell.restart === true);
  else checkFailsCell(cell.id, profile);
}

test('cells.json: unique ids, known profiles, and every swap profile of plexus.json is in a cell', () => {
  const profiles = Object.keys((JSON.parse(readFileSync(CONFIG, 'utf8')) as { profiles: object }).profiles);
  assert.equal(new Set(CELLS.map((c) => c.id)).size, CELLS.length);
  for (const cell of CELLS) if (cell.profile !== null) assert.ok(profiles.includes(cell.profile), `${cell.id}: profile ${cell.profile} exists`);
  assert.deepEqual(profiles.filter((p) => !CELLS.some((c) => c.profile === p)), []);
  const waits = CELLS.filter((c) => c.run === 'wait').map((c) => c.profile);
  assert.deepEqual(waits, [null, 'swap-execution', 'swap-execution-sqlite'], 'wait and resume run on the memory, file and sqlite journals');
});

test('last-failure-attribution says layer member; the reference adapter does too', async () => {
  const layers = await Promise.all(['swap-attribution', undefined].map((p) => withSystem(p, async (s) => (await evaluate(s, caseOf('billing-crash'))).attributions[0]?.layer)));
  assert.deepEqual(layers, ['member', 'member']);
});

/** A run scope whose members answer with `reply` and whose router answers `decision`; `calls` lists the members called. */
function linearScope(reply: (member: string) => MemberResult, decision: RouteDecision): { scope: RunScope; calls: string[] } {
  const calls: string[] = [];
  const scope: RunScope = {
    ctx: { runId: 'r1', system: 'test' },
    input: 'in',
    limits: { maxParallel: 1, maxIterations: 1, maxHandoffs: 1 },
    call: async (member) => (calls.push(member), { hopId: `h${calls.length}`, result: reply(member) }),
    route: async () => decision,
    matches: () => false,
    abandon: () => {},
  };
  return { scope, calls };
}

const runLinear = async (spec: TopologySpec, scope: RunScope): Promise<MemberResult> => (await createLinearTopology().bind(spec, { system: 'test', members: [] })).run('in', scope);

test('linear-topology: a route whose router failed runs the fallback, else fails in the routing layer', async () => {
  const broken: RouteDecision = { reason: 'router down', failed: true };
  const route: TopologySpec = { kind: 'route', candidates: ['billing'] };
  const none = linearScope((m) => ({ status: 'completed', output: m }), broken);
  assert.deepEqual(await runLinear(route, none.scope), { status: 'failed', output: '', reason: { code: 'error', layer: 'routing', detail: 'router down' } });
  assert.deepEqual(none.calls, []);

  const withFallback = linearScope((m) => ({ status: 'completed', output: m }), broken);
  assert.equal((await runLinear({ ...route, fallback: 'triage' }, withFallback.scope)).output, 'triage');

  const nobody = linearScope((m) => ({ status: 'completed', output: m }), {});
  assert.deepEqual((await runLinear(route, nobody.scope)).reason, { code: 'rejected', layer: 'routing' });
});

test('linear-topology: a sequence result carries the usage and cost of all its calls', async () => {
  const usage = { inputTokens: 4, outputTokens: 1 };
  const spent = linearScope((m) => ({ status: 'completed', output: m, usage, costUsd: 0.5 }), { member: 'billing' });
  const result = await runLinear({ kind: 'sequence', steps: ['triage', { kind: 'route', candidates: ['billing'] }] }, spent.scope);
  assert.deepEqual(result, { status: 'completed', output: 'billing', usage: { inputTokens: 8, outputTokens: 2 }, costUsd: 1 });

  const stopped = linearScope((m) => (m === 'billing' ? { status: 'stopped', output: '', reason: { code: 'error' }, costUsd: 2 } : { status: 'completed', output: m, costUsd: 0.5 }), { member: 'billing' });
  const halted = await runLinear({ kind: 'sequence', steps: ['triage', 'billing', 'manuals'] }, stopped.scope);
  assert.deepEqual([halted.status, halted.costUsd, 'usage' in halted], ['stopped', 2.5, false]);
  assert.deepEqual(stopped.calls, ['triage', 'billing']);
});

test('file-execution: a second begin with the same runKey replays a stored step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swap-test-'));
  try {
    let calls = 0;
    const work = async (): Promise<{ answer: string }> => ({ answer: `call ${++calls}` });

    const first = createFileExecution({ dir }, { name: 'execution', cwd: dir });
    const run = await first.begin('run-1');
    assert.deepEqual(await run.step('call:root.steps[0]:0', work), { answer: 'call 1' });
    const key = await run.put('the text sent');
    await run.end('completed');

    // same instance, same key: the stored step is returned, the function does not run
    const again = await first.begin('run-1');
    assert.deepEqual(await again.step('call:root.steps[0]:0', work), { answer: 'call 1' });

    // a new instance on the same directory, as after a restart
    const restarted = createFileExecution({ dir }, { name: 'execution', cwd: dir });
    const resumed = await restarted.begin('run-1');
    assert.deepEqual(await resumed.step('call:root.steps[0]:0', work), { answer: 'call 1' });
    assert.equal(calls, 1);
    assert.equal(await restarted.read?.(key), 'the text sent');

    // another run key starts clean
    const other = await restarted.begin('run-2');
    assert.deepEqual(await other.step('call:root.steps[0]:0', work), { answer: 'call 2' });
    assert.equal(await restarted.read?.('run-2:t1'), undefined);
    assert.deepEqual((await readdir(dir)).sort(), ['run-1.json', 'run-2.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file-execution: a signal reaches a wait, the first signal of a name wins, and a failed step stores nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swap-test-'));
  try {
    const port = createFileExecution({ dir }, { name: 'execution', cwd: dir });
    const run = await port.begin('run-1');
    const waiting = run.wait('approval', new Date(Date.now() + 60_000).toISOString());
    assert.equal(await port.signal('run-1', 'approval', { ok: true }), true);
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(await port.signal('run-1', 'approval', { ok: false }), false);
    assert.equal(await port.signal('run-1', 'early', 1), true);
    assert.equal(await port.signal('run-1', 'early', 2), false);
    assert.equal(await run.wait('early', new Date().toISOString()), 1);
    let attempts = 0;
    await assert.rejects(run.step('s', async () => { attempts++; throw new Error('boom'); }), /boom/);
    assert.equal(await run.step('s', async () => ++attempts), 2);
    await assert.rejects(port.signal('missing', 'x', 1), /unknown run/);
    await port.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file-execution: a remembered value survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swap-test-'));
  try {
    const first = createFileExecution({ dir }, { name: 'execution', cwd: dir });
    const run = await first.begin('run-1');
    assert.equal(await run.recall('call:root:0:task'), undefined);
    await run.remember('call:root:0:task', 'task-9');
    await first.close();

    const restarted = createFileExecution({ dir }, { name: 'execution', cwd: dir });
    const resumed = await restarted.begin('run-1');
    assert.equal(await resumed.recall('call:root:0:task'), 'task-9');
    assert.equal(await (await restarted.begin('run-2')).recall('call:root:0:task'), undefined);
    await restarted.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file-execution is a prototype-only adapter', () => {
  assert.deepEqual(fileExecution.map((d) => [d.name, d.fills, d.tiers]), [['file-execution', 'ExecutionPort', ['prototype']]]);
});

// One line of config -----------------------------------------------------------------------------------------------

/** Every string leaf of a JSON value, by dotted path. */
function leaves(value: unknown, path = ''): Record<string, string> {
  if (typeof value === 'object' && value !== null) {
    return Object.assign({}, ...Object.entries(value).map(([k, v]) => leaves(v, path ? `${path}.${k}` : k)));
  }
  return { [path]: String(value) };
}

/** The resolved config as units that can be swapped: each member, each port, and the rest of the system. */
function unitsOf(c: ResolvedConfig): Record<string, unknown> {
  const { members, ports, name, tier, host, topology, limits, registry } = c;
  return {
    ...Object.fromEntries(Object.entries(members).map(([id, ref]) => [`members.${id}`, ref])),
    'ports.registry': ports.registry,
    'ports.router': ports.routers.router,
    'ports.topology': ports.topology,
    'ports.execution': ports.execution,
    'ports.attribution': ports.attribution,
    system: { name, tier, host, topology, limits, registry },
  };
}

const changedUnits = (base: ResolvedConfig, other: ResolvedConfig): string[] => {
  const a = unitsOf(base);
  const b = unitsOf(other);
  return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
};

const rawProfile = (name: string): unknown => (JSON.parse(readFileSync(CONFIG, 'utf8')) as { profiles: Record<string, unknown> }).profiles[name];

test('each swap profile writes one value and changes exactly one adapter', async () => {
  const base = await loadConfig(CONFIG);
  for (const [profile, swap] of Object.entries(SWAPS)) {
    const resolved = await loadConfig(CONFIG, { profile });
    assert.equal(Object.keys(leaves(rawProfile(profile))).length, 1, `${profile} is one line of config`);
    assert.deepEqual(changedUnits(base, resolved), [swap.unit], `${profile} changes only ${swap.unit}`);
    const ref = unitsOf(resolved)[swap.unit] as { adapter: string; options?: unknown };
    const before = unitsOf(base)[swap.unit] as { adapter: string };
    assert.notEqual(ref.adapter, before.adapter);
    assert.deepEqual(Object.keys(ref), ['adapter'], `${profile} needs no options`);
    // the line points at a module of this example, whose descriptor is the adapter that is expected
    assert.match(ref.adapter, /^\.\/adapters\/.+\.ts$/);
    assert.equal((await loadDescriptor(swap.fills, ref.adapter, resolved.cwd)).name, swap.adapter);
  }
});

/** The member profiles: each replaces the entry of `billing` with another member adapter, and nothing else. */
const MEMBER_SWAPS = { 'swap-member': 'table-member', 'swap-member-agent-layers': 'agent-layers', 'swap-member-a2a': 'a2a-member' } as const;

test('each member swap replaces the entry of one member with another member adapter, and nothing else', async () => {
  const base = await loadConfig(CONFIG);
  assert.equal(base.members.billing?.adapter, 'function-member');
  for (const [profile, adapter] of Object.entries(MEMBER_SWAPS)) {
    const resolved = await loadConfig(CONFIG, { profile });
    assert.deepEqual(Object.keys(rawProfile(profile) as object), ['members'], profile);
    assert.deepEqual(Object.keys((rawProfile(profile) as { members: object }).members), ['billing'], profile);
    assert.deepEqual(changedUnits(base, resolved), ['members.billing'], profile);
    const ref = resolved.members.billing as { adapter: string };
    assert.notEqual(ref.adapter, base.members.billing?.adapter, profile);
    assert.equal((await loadDescriptor('MemberPort', ref.adapter, resolved.cwd)).name, adapter, profile);
  }
});

test('swap-execution-sqlite replaces the execution port with sqlite-execution, its path from SWAP_SQLITE_PATH', async () => {
  const base = await loadConfig(CONFIG);
  const resolved = await loadConfig(CONFIG, { profile: 'swap-execution-sqlite' });
  assert.deepEqual(changedUnits(base, resolved), ['ports.execution']);
  assert.deepEqual(resolved.ports.execution, { adapter: 'sqlite-execution', options: { path: '${env:SWAP_SQLITE_PATH:-:memory:}' } });
  assert.equal((await loadDescriptor('ExecutionPort', 'sqlite-execution', resolved.cwd)).name, 'sqlite-execution');
});

test('swap-execution-sqlite writes its journal at SWAP_SQLITE_PATH', async () => {
  const around = await fixture('swap-execution-sqlite');
  try {
    const s = await assembleWith(await loadConfig(CONFIG, { profile: 'swap-execution-sqlite' }), around.env);
    try {
      assert.equal((await s.run(caseOf('billing-refund').input)).status, 'completed');
    } finally {
      await s.close();
    }
    assert.ok((await readdir(around.dir)).includes('journal.db'));
  } finally {
    await around.close();
  }
});

test('swap-member-a2a: billing is called over A2A, once per case that reaches it', async () => {
  const around = await fixture('swap-member-a2a');
  try {
    assert.equal(new URL(around.env.SWAP_BILLING_A2A_URL as string).hostname, '127.0.0.1');
    const s = await assembleWith(await loadConfig(CONFIG, { profile: 'swap-member-a2a' }), around.env);
    try {
      const result = await s.run(caseOf('billing-refund').input);
      assert.equal(result.status, 'completed');
      assert.match(result.output, /refunds are issued/);
      assert.deepEqual(around.agent?.received, ['Request received: I need a refund for my last invoice']);
      assert.equal((await s.run(caseOf('product-setup').input)).status, 'completed');
      assert.equal(around.agent?.received.length, 1, 'a case routed to manuals does not reach the agent');
    } finally {
      await s.close();
    }
  } finally {
    await around.close();
  }
});

test('swap-host replaces the host and nothing else', async () => {
  const base = await loadConfig(CONFIG);
  const resolved = await loadConfig(CONFIG, { profile: 'swap-host' });
  assert.deepEqual(Object.keys(rawProfile('swap-host') as object), ['host']);
  assert.deepEqual(changedUnits(base, resolved), ['system']);
  assert.equal(base.host, undefined);
  assert.equal(resolved.host?.adapter, 'agent-layers');
  assert.deepEqual(unitsOf(base).system, { ...(unitsOf(resolved).system as object), host: undefined });
  assert.equal((await loadDescriptor('Host', 'agent-layers', resolved.cwd)).name, 'agent-layers');
});

test('swap-host: the host governs the calls; a member the rules do not allow is stopped by the host', async () => {
  const raw = JSON.parse(readFileSync(CONFIG, 'utf8')) as { members: Record<string, unknown>; topology: unknown };
  raw.members.admin = { adapter: 'function-member', options: { module: './members/manuals.ts#answer' } };
  raw.topology = { kind: 'sequence', steps: ['triage', 'admin'] };
  const config = resolveConfig(raw, { cwd: dirname(CONFIG), profile: 'swap-host' });
  const s = await assembleWith(config);
  try {
    assert.equal(s.tier, 'prototype');
    const result = await s.run('anything');
    assert.equal(result.status, 'stopped');
    assert.deepEqual([result.reason?.code, result.reason?.layer, result.reason?.by], ['denied', 'host', 'agent-layers']);
    assert.deepEqual(members(result), ['triage', 'admin']);
    const attributions = await s.attribute(result);
    assert.equal(attributions[0]?.layer, 'host');
  } finally {
    await s.close();
  }
});

test('static-registry trust with registry.requireListed: a direct call to an unsigned member is denied by the registry; an exempt one runs', async () => {
  const withTrust = (trust: Record<string, unknown>) => {
    const raw = JSON.parse(readFileSync(CONFIG, 'utf8')) as { ports: { registry: { options: Record<string, unknown> } }; registry?: unknown; topology: unknown };
    raw.ports.registry.options.trust = trust;
    raw.registry = { requireListed: true };
    raw.topology = { kind: 'sequence', steps: ['triage'] };
    return resolveConfig(raw, { cwd: dirname(CONFIG) });
  };
  const strict = await assembleWith(withTrust({ requireSigned: true }));
  try {
    const result = await strict.run('anything');
    assert.equal(result.status, 'stopped');
    assert.deepEqual([result.reason?.code, result.reason?.layer], ['denied', 'registry']);
    assert.deepEqual(members(result), ['triage']);
  } finally {
    await strict.close();
  }
  const exempt = await assembleWith(withTrust({ requireSigned: true, exempt: ['triage'] }));
  try {
    assert.equal((await exempt.run('anything')).status, 'completed');
  } finally {
    await exempt.close();
  }
});

test('swap-all is the port, member and host swaps together and nothing else', async () => {
  const base = await loadConfig(CONFIG);
  const resolved = await loadConfig(CONFIG, { profile: 'swap-all' });
  const all = rawProfile('swap-all') as { host: unknown; members: Record<string, unknown>; ports: Record<string, unknown> };
  assert.deepEqual(Object.keys(all).sort(), ['host', 'members', 'ports']);
  assert.deepEqual(all.host, (rawProfile('swap-host') as { host: unknown }).host);
  assert.deepEqual(all.members, (rawProfile('swap-member') as { members: unknown }).members);
  for (const [profile, swap] of Object.entries(SWAPS)) {
    const port = swap.unit.slice('ports.'.length);
    assert.deepEqual(all.ports[port], (rawProfile(profile) as { ports: Record<string, unknown> }).ports[port], profile);
  }
  assert.deepEqual(changedUnits(base, resolved), [...Object.values(SWAPS).map((s) => s.unit), 'members.billing', 'system'].sort());
  assert.equal(resolved.host?.adapter, 'agent-layers');
});
