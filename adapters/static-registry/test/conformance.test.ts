import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter, SAMPLE_ENTRIES } from '@agent-plexus/conformance';
import { adapter } from '../src/index.ts';

test('static-registry passes RegistryPort conformance', async () => {
  // The members come from the context: the suite's sample entries, with tags and attrs added by config.
  const report = await checkAdapter(adapter, {
    options: { entries: { billing: { tags: ['urgent'], attrs: { team: 'finance' } }, triage: { description: 'Routes requests' } } },
    fixtures: { ids: SAMPLE_ENTRIES.map((e) => e.id) },
  });
  assert.deepEqual(report.failures, []);
});
