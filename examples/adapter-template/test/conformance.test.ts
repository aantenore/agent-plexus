import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-plexus/conformance';
import { adapter, CHARS_KEY, createTemplateMember } from '../src/index.ts';

const call = { runId: 'r1', system: 's', hopId: 'h1', outbound: { remainingMs: 1000, hops: 0, maxHops: 3, rootRunId: 'r1', parentRunId: 'r1' }, checkpoint: async () => {} };

test('template adapter passes MemberPort conformance', async () => {
  const report = await checkAdapter(adapter, { options: { greeting: 'Hi' }, fixtures: { inputs: ['hello', { text: 'world' }] } });
  assert.deepEqual(report.failures, []);
});

test('the answer carries the input length in ext; an input over maxInputChars is refused', async () => {
  const member = createTemplateMember({ maxInputChars: 5 }, { name: 'greeter' });
  const ok = await member.invoke('hey', call);
  assert.equal(ok.output, 'Hello hey');
  assert.deepEqual(ok.ext, { [CHARS_KEY]: 3 });
  assert.equal((await member.invoke('too long', call)).reason?.code, 'rejected');
});
