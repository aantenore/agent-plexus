import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-plexus/conformance';
import { adapter } from '../../src/skill-router/index.ts';

test('skill-router passes AgentRouterPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { rules: [{ member: 'billing', matches: '(?i)invoice|refund' }, { member: 'manuals', tags: ['product'], matches: '(?i)setup', weight: 2 }] },
    fixtures: {
      cases: [
        { input: 'I need a refund for my last invoice', expect: 'billing' },
        { input: 'how do I setup the product', expect: 'manuals' },
        { input: 'invoice setup', expect: 'manuals' },
        { input: 'hello', expect: null },
      ],
    },
  });
  assert.deepEqual(report.failures, []);
});
