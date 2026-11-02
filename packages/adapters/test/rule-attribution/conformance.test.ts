import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter, hop } from '@agent-plexus/conformance';
import { adapter } from '../../src/rule-attribution/index.ts';

test('rule-attribution passes AttributionPort conformance', async () => {
  const failed = hop({ member: 'billing', node: 'root.steps[1]', status: 'failed', reason: { code: 'error', layer: 'member' } });
  const nobody = hop({ member: '', node: 'root', status: 'stopped', reason: { code: 'rejected', layer: 'routing' }, route: {} });
  const report = await checkAdapter(adapter, {
    fixtures: {
      cases: [
        { input: { record: [hop({ member: 'triage' }), failed], result: { status: 'failed', output: '', reason: { code: 'error', layer: 'member' } }, scores: [] }, expect: [{ layer: 'member', member: 'billing' }] },
        { input: { record: [nobody], result: { status: 'stopped', output: '', reason: { code: 'rejected', layer: 'routing' } }, scores: [] }, expect: [{ layer: 'routing' }] },
        { input: { record: [hop({ member: 'triage' })], result: { status: 'completed', output: 'ok' }, scores: [] }, expect: [] },
      ],
    },
  });
  assert.deepEqual(report.failures, []);
});
