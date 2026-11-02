import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '../src/errors.ts';
import { collectLimits, limitFindings, resolveLimits, SYSTEM_LIMITS } from '../src/system-limits.ts';

test('absent limits take the defaults of the table', () => {
  const v = resolveLimits(undefined);
  assert.deepEqual([v.timeoutMs, v.maxSteps, v.maxDepth, v.maxParallel, v.maxRepeats, v.maxCandidates, v.maxRecords], [300000, 20, 3, 4, 3, 20, 500]);
  assert.equal(Object.keys(v).length, Object.keys(SYSTEM_LIMITS).length);
});

test('configured values, unbounded where allowed', () => {
  const v = resolveLimits({ system: { maxSteps: 'unbounded', maxDepth: 0, timeoutMs: 5 }, router: { maxCandidates: 200 } });
  assert.deepEqual([v.maxSteps, v.maxDepth, v.timeoutMs, v.maxCandidates], ['unbounded', 0, 5, 200]);
});

test('${env:NAME} and ${env:NAME:-default} as whole strings', () => {
  const v = resolveLimits({ system: { maxSteps: '${env:STEPS}', timeoutMs: '${env:NOPE:-1234}', stepTimeoutMs: '${env:T}' } }, { STEPS: '7', T: 'unbounded' });
  assert.deepEqual([v.maxSteps, v.timeoutMs, v.stepTimeoutMs], [7, 1234, 'unbounded']);
});

test('an empty env value is a set value, not the default', () => {
  assert.throws(() => resolveLimits({ system: { maxSteps: '${env:E:-7}' } }, { E: '' }), /limits.system.maxSteps: environment variable E is not a number/);
});

test('rejected values name their path, all at once', () => {
  assert.throws(
    () => resolveLimits({ system: { maxSteps: 0, maxParallel: 65, maxRepeats: 'unbounded', timeoutMs: '${env:MISSING}', maxIterations: 1.5, bogus: 1 }, registry: { maxCardBytes: 10 }, nope: {} }, {}),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      const text = (err as ConfigError).errors.join('\n');
      for (const needle of ['limits.system.maxSteps: must be >= 1', 'limits.system.maxParallel: must be <= 64', 'limits.system.maxRepeats', 'limits.system.timeoutMs: environment variable MISSING is not set', 'limits.system.maxIterations', 'limits.system.bogus: unknown limit', 'limits.nope: unknown limit group (known: system, router, attribution)']) {
        assert.ok(text.includes(needle), `missing: ${needle}\n${text}`);
      }
      return true;
    },
  );
});

test('an env value that is not a number is rejected', () => {
  assert.throws(() => resolveLimits({ system: { maxSteps: '${env:X}' } }, { X: 'many' }), /limits.system.maxSteps: environment variable X is not a number/);
  assert.throws(() => resolveLimits({ system: { maxSteps: '5' } }), /limits.system.maxSteps/);
});

test('findings: defaults are clean; unbounded fails; outside the safe range warns', () => {
  assert.deepEqual(limitFindings(resolveLimits(undefined)), []);
  const f = limitFindings(resolveLimits({ system: { timeoutMs: 'unbounded', maxSteps: 500, maxParallel: 32, maxDepth: 'unbounded' }, router: { maxCandidates: 100 } }));
  const by = Object.fromEntries(f.map((x) => [x.path, x.severity]));
  assert.deepEqual(by, {
    'limits.system.timeoutMs': 'fail', 'limits.system.maxSteps': 'warn', 'limits.system.maxDepth': 'fail',
    'limits.system.maxParallel': 'warn', 'limits.router.maxCandidates': 'warn',
  });
});

test('a deprecated limit group is ignored and noted, not rejected', () => {
  const problems: string[] = [];
  const deprecated: { path: string; message: string }[] = [];
  const values = collectLimits({ registry: { maxCardBytes: 10 } }, {}, problems, deprecated);
  assert.deepEqual(problems, []);
  assert.deepEqual(deprecated.map((d) => d.path), ['$.limits.registry']);
  assert.equal(values.maxSteps, 20);
  assert.doesNotThrow(() => resolveLimits({ registry: { cardTtlMs: 1 } }, {}));
});
