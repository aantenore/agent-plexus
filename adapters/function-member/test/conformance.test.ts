import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAdapter } from '@agent-plexus/conformance';
import { adapter } from '../src/index.ts';

test('function-member passes MemberPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { module: './fixtures/members.ts#answer', description: 'Echoes', tags: ['echo'], attrs: { region: 'eu' } },
    ctx: { cwd: dirname(fileURLToPath(import.meta.url)) },
    fixtures: { inputs: ['hello', { text: 'world' }] },
  });
  assert.deepEqual(report.failures, []);
});
