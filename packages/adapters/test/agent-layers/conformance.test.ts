import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { compose, loadConfig } from '@agent-layers/core';
import { checkAdapter as checkLayersAdapter } from '@agent-layers/conformance';
import { adapter as basicTopology } from '@agent-plexus/adapters/basic-topology';
import { adapter as memoryExecution } from '@agent-plexus/adapters/memory-execution';
import { adapter as ruleAttribution } from '@agent-plexus/adapters/rule-attribution';
import { checkAdapter, checkSystem } from '@agent-plexus/conformance';
import { hostAdapter, memberAdapter } from '../../src/agent-layers/index.ts';
import { runtimeAdapter } from '../../src/agent-layers/runtime.ts';
import { fixtures } from './helpers.ts';

const entry = (id: string) => ({ id, name: id, description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } });

test('the agent-layers member passes MemberPort conformance', async () => {
  const report = await checkAdapter(memberAdapter, {
    options: { config: './layers.json', agent: 'helper', description: 'Answers briefly', tags: ['support'] },
    ctx: { cwd: fixtures },
    fixtures: { inputs: ['ping', 'hello'] },
  });
  assert.deepEqual(report.failures, []);
});

test('the agent-layers member works inside an assembled system', async () => {
  const report = await checkSystem(memberAdapter, {
    adapters: [basicTopology, memoryExecution, ruleAttribution],
    options: { config: './layers.json', agent: 'helper' },
    cwd: fixtures,
    input: 'ping',
  });
  assert.deepEqual(report.failures, []);
});

test('the agent-layers host passes the host hook conformance', async () => {
  const report = await checkAdapter(hostAdapter, {
    options: { config: './layers.json' },
    ctx: { cwd: fixtures },
    fixtures: {
      member: entry('billing'),
      denied: entry('admin'),
      caller: { id: 'alice', kind: 'user', roles: ['staff'], scopes: [] },
      audience: 'https://billing.example',
      block: { text: 'please NOSEND this', stage: 'send' },
      score: {
        case: { id: 'c1', input: 'ping', expected: { output: { equals: 'pong' } } },
        result: { runId: 'r1', status: 'completed', output: 'pong', record: [] },
      },
    },
  });
  assert.deepEqual(report.failures, []);
});

test('the runtime plugin passes the agent-layers RuntimePort conformance', async () => {
  const cwd = join(fixtures, 'runtime');
  const stack = await compose(await loadConfig(join(cwd, 'layers.json')));
  try {
    const report = await checkLayersAdapter(runtimeAdapter, {
      options: { system: './plexus.json' },
      ctx: { cwd },
      fixtures: { stack, agent: { name: 'desk', model: 'mock', instructions: 'Hand the request to the desk system.', tools: [] }, input: 'hello' },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await stack.close();
  }
});
