import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-plexus/conformance';
import { adapter } from '../../src/memory-execution/index.ts';

test('memory-execution passes ExecutionPort conformance', async () => {
  // In memory: not durable, holds no run across instances.
  const report = await checkAdapter(adapter, { fixtures: { alive: { module: new URL('../../src/memory-execution/index.ts', import.meta.url).href } } });
  assert.deepEqual(report.failures, []);
});
