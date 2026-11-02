// Interop: a real agent-layers stack served over A2A by the gateway, called through a2a-member.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { channelAdapter } from '@agent-layers/adapter-a2a';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { compose, resolveProfile, type Stack, type StackConfig } from '@agent-layers/core';
import { serveStack, type GatewayHandle } from '@agent-layers/gateway';
import { assemble, prototypeHost, resolveConfig } from '@agent-plexus/core';
import { createA2AMember } from '../src/index.ts';
import { decodeRef } from '../src/task.ts';
import { callContext } from './fake.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TOKEN = 'dev-token';

let stack: Stack;
let gateway: GatewayHandle;
let cardUrl: string;

before(async () => {
  const config: StackConfig = {
    agents: { helper: { instructions: 'Answer billing questions.', model: 'mock' } },
    layers: {
      model: { adapter: 'mock-model', options: { rules: [{ match: '^ping', reply: 'pong' }] } },
      runtime: { adapter: 'basic-runtime' },
      identity: { adapter: 'static-identity', options: { tokens: { [TOKEN]: { subject: 'alice' } } } },
      channels: [{ adapter: 'a2a' }],
    },
    profiles: { p: { tier: 'prototype' } },
  };
  stack = await compose(resolveProfile(config, 'p'), { adapters: [mockModel, basicRuntime, identityAdapter, channelAdapter] });
  gateway = await serveStack(stack, { port: 0, host: '127.0.0.1' });
  cardUrl = `${gateway.url}/a2a/helper/.well-known/agent-card.json`;
});

after(async () => {
  await gateway.close();
  await stack.close();
});

test('describe reads the card of the stack agent; the endpoint is the gateway route', async () => {
  const entry = await createA2AMember({ url: cardUrl }, { name: 'billing' }).describe();
  assert.equal(entry.endpoint.protocol, 'a2a');
  assert.equal(entry.endpoint.url, `${gateway.url}/a2a/helper`);
  assert.equal(entry.skills.length, 1);
  assert.deepEqual(entry.trust, { signed: false, pinned: true });
});

test('invoke: a completed result with the answer of the mock model, usage included', async () => {
  const member = createA2AMember({ url: cardUrl, pollMs: 20 }, { name: 'billing' });
  const ctx = callContext({ credential: TOKEN });
  const result = await member.invoke('ping', ctx);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'pong');
  assert.ok(result.usage && result.usage.inputTokens > 0, 'usage reported by the stack travels in the task metadata');
});

test('invoke: the bounds extension is accepted by the stack, which ignores what it does not use', async () => {
  const member = createA2AMember({ url: cardUrl, pollMs: 20 }, { name: 'billing' });
  const result = await member.invoke({ text: 'ping' }, callContext({ credential: TOKEN, remainingMs: 30_000 }));
  assert.deepEqual([result.status, result.output], ['completed', 'pong']);
});

test('invoke: over the hop limit the stack refuses the call; its report says hop_limit', async () => {
  for (const boundsUri of ['canonical', 'plexus'] as const) {
    const member = createA2AMember({ url: cardUrl, pollMs: 20, boundsUri }, { name: 'billing' });
    const outbound = { remainingMs: 30_000, hops: 5, maxHops: 4, rootRunId: 'root-1', parentRunId: 'run-1' };
    const result = await member.invoke('ping', callContext({ credential: TOKEN, outbound }));
    assert.deepEqual([result.status, result.reason?.code, result.reason?.by], ['stopped', 'hop_limit', 'billing']);
  }
});

test('invoke: a task that is not finished at once is checkpointed and polled to the end', async () => {
  const member = createA2AMember({ url: cardUrl, pollMs: 20 }, { name: 'billing' });
  const ctx = callContext({ credential: TOKEN });
  const result = await member.invoke('ping', ctx);
  assert.equal(result.status, 'completed');
  // the stack answers a returnImmediately send with a working task, so the reference was journaled
  assert.equal(ctx.checkpoints.length, 1);
  assert.ok(decodeRef(ctx.checkpoints[0]!));
});

test('resume without input on a finished task returns its result', async () => {
  const member = createA2AMember({ url: cardUrl, pollMs: 20 }, { name: 'billing' });
  const ctx = callContext({ credential: TOKEN });
  await member.invoke('ping', ctx);
  const again = await member.resume!(ctx.checkpoints[0]!, undefined, callContext({ credential: TOKEN }));
  assert.deepEqual([again.status, again.output], ['completed', 'pong']);
});

test('no credential: the gateway refuses and the result is a fixed failure', async () => {
  const result = await createA2AMember({ url: cardUrl, pollMs: 20 }, { name: 'billing' }).invoke('ping', callContext());
  assert.deepEqual([result.status, result.reason?.code, result.reason?.detail], ['failed', 'error', 'remote agent call failed']);
});

test('a plexus system end to end: function-member triage, then the stack through a2a-member', async () => {
  const raw = {
    system: { name: 'desk' },
    members: {
      triage: { adapter: 'function-member', options: { module: './members.ts#triage' } },
      billing: { adapter: 'a2a-member', options: { url: cardUrl, audience: 'agents', pollMs: 20, timeoutMs: 20_000 } },
    },
    ports: {
      topology: { adapter: 'basic-topology' },
      execution: { adapter: 'memory-execution' },
      attribution: { adapter: 'rule-attribution' },
    },
    topology: { kind: 'sequence', steps: ['triage', 'billing'] },
  };
  const base = prototypeHost({ quiet: true });
  // The host mints the token for the member's audience; the member sends it as Bearer.
  const host = { ...base, gate: { ...base.gate, token: async (_caller: unknown, audience: string) => (audience === 'agents' ? TOKEN : undefined) } };
  const system = await assemble(await resolveConfig(raw, { cwd: fixtures }), { host, cwd: fixtures });
  try {
    const result = await system.run('where is my invoice?');
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'pong');
    assert.deepEqual(result.record.map((h) => [h.member, h.status]), [['triage', 'completed'], ['billing', 'completed']]);
    assert.ok(result.record[1]!.usage, 'the usage of the remote stack is in the hop record');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
    const entries = await system.entries();
    assert.equal(entries.find((e) => e.id === 'billing')?.endpoint.protocol, 'a2a');
  } finally {
    await system.close();
  }
});
