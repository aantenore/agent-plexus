import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-plexus/conformance';
import { adapter } from '../src/index.ts';

test('basic-topology passes TopologyPort conformance for every kind', async () => {
  const report = await checkAdapter(adapter);
  assert.deepEqual(report.failures, []);
});
