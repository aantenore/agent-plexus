import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, mergeConfig, resolveConfig } from '../src/config.ts';
import { ConfigError } from '../src/errors.ts';

const base = () => ({
  system: { name: 'support' },
  host: { adapter: 'agent-layers', options: { config: './x.json' } },
  members: { triage: { adapter: 'function-member', options: { module: './t.js#a' } }, billing: { adapter: 'a2a-member', options: { url: 'https://x' } } },
  ports: {
    registry: { adapter: 'static-registry' },
    router: { adapter: 'skill-router', options: { rules: [1, 2] } },
    topology: { adapter: 'basic-topology' },
    execution: { adapter: 'memory-execution', options: { a: 1 } },
    attribution: { adapter: 'rule-attribution' },
  },
  topology: { kind: 'sequence', steps: ['triage', { kind: 'route', candidates: ['billing'], fallback: 'triage' }] },
  limits: { system: { maxSteps: 10 } },
  profiles: {
    prototype: { host: null },
    production: { tier: 'production', registry: { requireSigned: true }, ports: { execution: { adapter: 'dbos' }, router: { options: { rules: [3] } } }, limits: { system: { timeoutMs: 1000 } } },
  },
});
const opts = { cwd: '/tmp' };

test('without a profile: tier prototype, limits defaulted, router normalised', () => {
  const c = resolveConfig(base(), opts);
  assert.equal(c.name, 'support');
  assert.equal(c.tier, 'prototype');
  assert.equal(c.host?.adapter, 'agent-layers');
  assert.equal(c.limits.maxSteps, 10);
  assert.equal(c.limits.timeoutMs, 300000);
  assert.deepEqual(Object.keys(c.ports.routers), ['router']);
  assert.equal(c.registry.requireSigned, false);
  assert.equal(c.cwd, '/tmp');
});

test('a profile merges deeply; null removes a key; arrays replace; a new adapter drops the old options', () => {
  const p = resolveConfig(base(), { ...opts, profile: 'production' });
  assert.equal(p.tier, 'production');
  assert.equal(p.registry.requireSigned, true);
  assert.deepEqual(p.ports.execution, { adapter: 'dbos' });
  assert.equal(p.ports.routers.router?.adapter, 'skill-router');
  assert.deepEqual(p.ports.routers.router?.options, { rules: [3] });
  assert.equal(p.limits.maxSteps, 10);
  assert.equal(p.limits.timeoutMs, 1000);
  assert.deepEqual(p.ports.registry, { adapter: 'static-registry' });
  assert.equal(resolveConfig(base(), { ...opts, profile: 'prototype' }).host, undefined);
});

test('mergeConfig: nested merge, null removes, arrays and scalars replace', () => {
  const merged = mergeConfig({ a: { b: 1, c: [1, 2], d: 'x' }, e: 1 }, { a: { c: [9], d: null }, e: 2, f: null }) as Record<string, unknown>;
  assert.deepEqual(merged, { a: { b: 1, c: [9] }, e: 2 });
  assert.deepEqual(mergeConfig({ kind: 'sequence', steps: ['a'] }, { kind: 'loop', body: 'a' }), { kind: 'loop', body: 'a' });
});

test('named routers keep their names', () => {
  const raw = base();
  (raw.ports as Record<string, unknown>).router = { router: { adapter: 'skill-router' }, fast: { adapter: 'model-router' } };
  assert.deepEqual(Object.keys(resolveConfig(raw, opts).ports.routers), ['router', 'fast']);
});

test('an undefined profile is an error naming the known ones', () => {
  assert.throws(() => resolveConfig(base(), { ...opts, profile: 'staging' }), /profiles\.staging: not defined \(known: prototype, production\)/);
});

test('all structural problems are reported at once, with paths', () => {
  const raw = base() as Record<string, any>;
  raw.system = {};
  raw.members.triage = { options: {} };
  raw.ports.execution = 'memory';
  raw.topology = { kind: 'sequence', steps: [{ kind: 'loop', body: 'x', until: { fn: 'nohash', matches: '(' } }, { kind: 'wat' }, 7, { kind: 'sequence', steps: ['x'], extra: 1 }] };
  raw.limits = { system: { maxSteps: 0 } };
  raw.tier = 'staging';
  raw.stray = true;
  assert.throws(() => resolveConfig(raw, opts), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    const text = err.errors.join('\n');
    for (const needle of [
      '$.system.name: required', '$.members.triage.adapter: required', '$.ports.execution: expected object', '$.tier', '$.stray: unknown property',
      '$.topology.steps[3].extra: unknown property', '$.topology.steps[0].until.fn: expected "<module>#<export>"', '$.topology.steps[0].until.matches: not a valid regular expression',
      '$.topology.steps[1].kind: must be one of', '$.topology.steps[2]: expected a member id', 'limits.system.maxSteps: must be >= 1',
    ]) assert.ok(text.includes(needle), `missing: ${needle}\n${text}`);
    return true;
  });
});

test('problems carry the profile name', () => {
  const raw = base() as Record<string, any>;
  raw.profiles.production.limits = { system: { maxSteps: 0 } };
  assert.throws(() => resolveConfig(raw, { ...opts, profile: 'production' }), /maxSteps: must be >= 1 \(profile production\)/);
});

test('env interpolation in limits uses the given env', () => {
  const raw = base() as Record<string, any>;
  raw.limits = { system: { maxSteps: '${env:S}' } };
  assert.equal(resolveConfig(raw, { ...opts, env: { S: '3' } }).limits.maxSteps, 3);
});

test('loadConfig reads a file and resolves paths against its directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-'));
  const file = join(dir, 'system.json');
  await writeFile(file, JSON.stringify(base()));
  const c = await loadConfig(file, { profile: 'production' });
  assert.equal(c.cwd, dir);
  assert.equal(c.tier, 'production');
  await writeFile(file, '{ nope');
  await assert.rejects(loadConfig(file), /cannot read as JSON/);
});
