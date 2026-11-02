import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterLimitFindings, interpolate } from '../src/adapter-config.ts';
import { defineAdapter } from '../src/adapter.ts';
import { ConfigError } from '../src/errors.ts';
import { defineLimits } from '../src/limits.ts';
import { prototypeHost } from '../src/prototype-host.ts';
import { readinessFindings } from '../src/readiness.ts';
import { createAdapter } from '../src/resolve.ts';
import { resolveConfig } from '../src/config.ts';

const limits = defineLimits({
  maxRuns: { path: 'options.maxRuns', default: 1000, unit: 'count', min: 1, max: 100000, unbounded: 'fail', safe: { max: 5000 }, why: 'x' },
  timeouts: { path: 'options.tools[].timeoutMs', default: 10, unit: 'ms', min: 1, why: 'x' },
});
const descriptor = defineAdapter({
  fills: 'ExecutionPort', name: 'lim', maps: {}, tiers: ['production'], limits,
  optionsSchema: { type: 'object', properties: { maxRuns: {}, tools: {} } },
  create: () => ({ name: 'lim', begin: async () => { throw new Error('unused'); }, signal: async () => false }),
});
const ctx = (env: Record<string, string> = {}) => ({ system: 'sys', name: 'e', cwd: '.', env, telemetry: prototypeHost().telemetry });
const load = async () => descriptor as never;

test('interpolate: whole and embedded references, recursively, with the path of a missing variable', () => {
  const problems: string[] = [];
  const out = interpolate({ a: '${env:A}', b: ['x-${env:B:-b}-${env:A}'], c: { d: '${env:NOPE}' }, n: 3 }, { A: '1' }, problems, '$.o');
  assert.deepEqual(out, { a: '1', b: ['x-b-1'], c: { d: '' }, n: 3 });
  assert.deepEqual(problems, ['$.o.c.d: environment variable NOPE is not set']);
});

test('an empty env value is a set value, for a reference with or without a default', () => {
  const problems: string[] = [];
  assert.deepEqual(interpolate({ a: '${env:E}', b: '${env:E:-d}' }, { E: '' }, problems, '$.o'), { a: '', b: '' });
  assert.deepEqual(problems, []);
});

test('adapter limit values from env become numbers and are range-checked with the config path', async () => {
  const made = await createAdapter(load, 'ExecutionPort', { adapter: 'lim', options: { maxRuns: '${env:R}' } }, ctx({ R: '50' }), '$.ports.execution');
  assert.equal(made.options.maxRuns, 50);
  await assert.rejects(
    createAdapter(load, 'ExecutionPort', { adapter: 'lim', options: { maxRuns: 0, tools: [{ timeoutMs: 5 }, { timeoutMs: 0 }] } }, ctx(), '$.ports.execution'),
    (e: unknown) => e instanceof ConfigError && e.errors.join('|') === '$.ports.execution.options.maxRuns: must be >= 1|$.ports.execution.options.tools[1].timeoutMs: must be >= 1',
  );
});

test('adapter limit findings on a production tier: unbounded, outside the safe range, defaults judged', () => {
  const specs = Object.values(limits);
  assert.deepEqual(adapterLimitFindings(specs, {}, '$.ports.execution'), []);
  const f = adapterLimitFindings(specs, { maxRuns: 'unbounded' }, '$.ports.execution');
  assert.deepEqual(f.map((x) => [x.severity, x.path]), [['fail', '$.ports.execution.options.maxRuns']]);
  assert.deepEqual(adapterLimitFindings(specs, { maxRuns: 9000 }, '$.p').map((x) => [x.severity, x.path]), [['warn', '$.p.options.maxRuns']]);
});

test('readiness includes the adapters\' limit findings', () => {
  const config = resolveConfig({
    system: { name: 's' }, members: {}, tier: 'production',
    ports: { topology: { adapter: 't' }, execution: { adapter: 'lim' }, attribution: { adapter: 'a' } }, topology: { kind: 'sequence', steps: ['x'] },
  }, { cwd: '.' });
  const host = { ...prototypeHost(), tier: 'production' as const };
  const findings = readinessFindings({
    config, host, entries: [], topologyKinds: ['sequence'], routers: [],
    adapters: [{ path: '$.ports.execution', descriptor, options: { maxRuns: 'unbounded' } }],
  });
  assert.ok(findings.some((f) => f.severity === 'fail' && f.path === '$.ports.execution.options.maxRuns'));
});
