import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assemble, loadConfig, loadDescriptor, prototypeHost, resolveConfig,
  type Attribution, type EvalCase, type Fills, type ResolvedConfig, type System, type SystemResult,
} from '@agent-plexus/core';
import { adapters as fileExecution, createFileExecution } from '../adapters/file-execution.ts';

const here = (name: string): string => fileURLToPath(new URL(`../${name}`, import.meta.url));
const CONFIG = here('plexus.json');
const CASES = JSON.parse(readFileSync(here('cases.json'), 'utf8')) as EvalCase[];

/** The base profile (undefined) and what each swap profile changes: the unit of the resolved config and the adapter now in it. */
const SWAPS = {
  'swap-registry': { unit: 'ports.registry', adapter: 'file-registry', fills: 'RegistryPort' },
  'swap-routing': { unit: 'ports.router', adapter: 'keyword-router', fills: 'AgentRouterPort' },
  'swap-topology': { unit: 'ports.topology', adapter: 'linear-topology', fills: 'TopologyPort' },
  'swap-execution': { unit: 'ports.execution', adapter: 'file-execution', fills: 'ExecutionPort' },
  'swap-attribution': { unit: 'ports.attribution', adapter: 'last-failure-attribution', fills: 'AttributionPort' },
} as const satisfies Record<string, { unit: string; adapter: string; fills: Fills }>;

const PROFILES: (string | undefined)[] = [undefined, ...Object.keys(SWAPS), 'swap-member', 'swap-member-agent-layers', 'swap-host', 'swap-all'];

/**
 * Who the crash case is attributed to. The agent-layers billing agent stops on "crash" through a guard of its own stack;
 * a blocked guard check is blamed on the member upstream of it (triage), by design of the reference attribution.
 */
const CRASH_BLAME: Record<string, { member: string; billingCode: string }> = {
  'swap-member-agent-layers': { member: 'triage', billingCode: 'guard_block' },
};
const BASE_BLAME = { member: 'billing', billingCode: 'error' };
const label = (profile: string | undefined): string => profile ?? 'base';

const caseOf = (id: string): EvalCase => {
  const found = CASES.find((c) => c.id === id);
  assert.ok(found, `case ${id} is in cases.json`);
  return found;
};

/** A system with the host of its config, else the quiet prototype host. */
function assembleWith(config: ResolvedConfig): Promise<System> {
  return assemble(config, config.host ? {} : { host: prototypeHost({ quiet: true }) });
}

async function open(profile?: string): Promise<System> {
  return assembleWith(await loadConfig(CONFIG, profile ? { profile } : {}));
}

/** Runs one case the way `eval` does: run, score, and attribute when it did not pass. */
async function evaluate(s: System, evalCase: EvalCase): Promise<{ passed: boolean; result: SystemResult; attributions: Attribution[] }> {
  const result = await s.run(evalCase.input);
  const scores = await s.score(evalCase, result);
  const passed = result.status === 'completed' && scores.every((x) => x.value >= 1);
  return { passed, result, attributions: passed ? [] : await s.attribute(result, scores) };
}

/** Runs `fn` on the system of a profile and closes it. */
async function withSystem<T>(profile: string | undefined, fn: (s: System) => Promise<T>): Promise<T> {
  const s = await open(profile);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

const members = (result: SystemResult): string[] => result.record.map((h) => h.member);

for (const profile of PROFILES) {
  test(`${label(profile)}: check has no FAIL`, async () => {
    const failures = await withSystem(profile, async (s) => (await s.check()).filter((f) => f.severity === 'fail'));
    assert.deepEqual(failures, []);
  });

  test(`${label(profile)}: the billing and product cases complete and route like the base`, async () => {
    await withSystem(profile, async (s) => {
      const billing = await evaluate(s, caseOf('billing-refund'));
      assert.equal(billing.passed, true);
      assert.deepEqual(members(billing.result), ['triage', 'billing']);
      const product = await evaluate(s, caseOf('product-setup'));
      assert.equal(product.passed, true);
      assert.deepEqual(members(product.result), ['triage', 'manuals']);
    });
  });

  test(`${label(profile)}: the crash case fails and attribution names member ${(CRASH_BLAME[profile ?? ''] ?? BASE_BLAME).member}`, async () => {
    const blame = CRASH_BLAME[profile ?? ''] ?? BASE_BLAME;
    await withSystem(profile, async (s) => {
      const crash = await evaluate(s, caseOf('billing-crash'));
      assert.equal(crash.passed, false);
      assert.equal(crash.result.status, 'stopped');
      const billing = crash.result.record.find((h) => h.member === 'billing');
      assert.equal(billing?.status, 'stopped');
      assert.equal(billing?.reason?.code, blame.billingCode);
      assert.ok(crash.attributions.length > 0, 'a failed run is attributed');
      assert.equal(crash.attributions[0]?.member, blame.member);
      if (blame.member === 'billing') assert.equal(crash.attributions[0]?.hopId, billing?.hopId);
    });
  });
}

test('last-failure-attribution says layer member; the reference adapter does too', async () => {
  const layers = await Promise.all(['swap-attribution', undefined].map((p) => withSystem(p, async (s) => (await evaluate(s, caseOf('billing-crash'))).attributions[0]?.layer)));
  assert.deepEqual(layers, ['member', 'member']);
});

test('a topology kind the adapter cannot run fails check with a clear finding', async () => {
  const failures = await withSystem('unsupported-kind', async (s) => (await s.check()).filter((f) => f.severity === 'fail'));
  const kind = failures.find((f) => /kind "loop" is not supported by the topology adapter/.test(f.message));
  assert.ok(kind, `a finding names the kind (got: ${failures.map((f) => f.message).join('; ')})`);
  assert.equal(kind.path, '$.topology');
  assert.equal(failures.length, 1, 'the bind failure the finding explains is not reported twice');
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

test('file-execution: a signal reaches a wait, and a failed step stores nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swap-test-'));
  try {
    const port = createFileExecution({ dir }, { name: 'execution', cwd: dir });
    const run = await port.begin('run-1');
    const waiting = run.wait('approval', new Date(Date.now() + 60_000).toISOString());
    await port.signal('run-1', 'approval', { ok: true });
    assert.deepEqual(await waiting, { ok: true });
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

test('swap-member changes one option of one member', async () => {
  const base = await loadConfig(CONFIG);
  const resolved = await loadConfig(CONFIG, { profile: 'swap-member' });
  assert.equal(Object.keys(leaves(rawProfile('swap-member'))).length, 1);
  assert.deepEqual(changedUnits(base, resolved), ['members.billing']);
  const diff = (a: unknown, b: unknown): string[] => {
    const [x, y] = [leaves(a), leaves(b)];
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => x[k] !== y[k]);
  };
  assert.deepEqual(diff(base.members.billing, resolved.members.billing), ['options.module']);
  assert.equal(resolved.members.billing?.adapter, base.members.billing?.adapter);
});

test('swap-member-agent-layers replaces the entry of one member and nothing else', async () => {
  const base = await loadConfig(CONFIG);
  const resolved = await loadConfig(CONFIG, { profile: 'swap-member-agent-layers' });
  assert.deepEqual(Object.keys(rawProfile('swap-member-agent-layers') as object), ['members']);
  assert.deepEqual(Object.keys((rawProfile('swap-member-agent-layers') as { members: object }).members), ['billing']);
  assert.deepEqual(changedUnits(base, resolved), ['members.billing']);
  assert.equal(resolved.members.billing?.adapter, 'agent-layers');
  assert.equal(base.members.billing?.adapter, 'function-member');
  assert.equal((await loadDescriptor('MemberPort', 'agent-layers', resolved.cwd)).name, 'agent-layers');
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

test('swap-all is the six swaps together and nothing else', async () => {
  const base = await loadConfig(CONFIG);
  const resolved = await loadConfig(CONFIG, { profile: 'swap-all' });
  assert.equal(Object.keys(leaves(rawProfile('swap-all'))).length, 6);
  assert.deepEqual(changedUnits(base, resolved), [...Object.values(SWAPS).map((s) => s.unit), 'members.billing'].sort());
});
