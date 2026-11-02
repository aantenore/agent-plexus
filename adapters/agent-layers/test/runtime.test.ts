import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { compose, loadConfig, type AccessQuestion, type Caller, type RunResult } from '@agent-layers/core';
import { adapters as indexAdapters } from '../src/index.ts';
import { adapters, runtimeAdapter } from '../src/runtime.ts';
import { layersReason, runResultOf } from '../src/map.ts';
import { seen } from './fixtures/members.ts';
import { fixtures, recorder } from './helpers.ts';

const config = join(fixtures, 'runtime', 'layers.json');
const alice: Caller = { id: 'alice', kind: 'user', roles: ['staff'], scopes: [], credential: 'alice-secret-credential' };

async function run(profile: string | undefined, input = 'hello', caller: Caller | undefined = alice): Promise<{ result: RunResult; records: ReturnType<typeof recorder>['records'] }> {
  const { records, compose: composeOptions } = recorder();
  const stack = await compose(await loadConfig(config, profile ? { profile } : {}), composeOptions);
  try {
    const result = await (await stack.agent('desk')).run(input, caller ? { caller } : {});
    return { result, records };
  } finally {
    await stack.close();
  }
}

test('the two entry points expose their own descriptors', () => {
  assert.deepEqual(adapters, [runtimeAdapter]);
  assert.deepEqual([runtimeAdapter.port, runtimeAdapter.layer, runtimeAdapter.name, runtimeAdapter.direction], ['RuntimePort', 'harness', 'agent-plexus', 'outbound']);
  assert.deepEqual(runtimeAdapter.tiers, ['prototype', 'production']);
  assert.deepEqual(indexAdapters.map((a) => a.fills), ['Host', 'MemberPort']);
});

test('a stack whose runtime is a system returns the output of the system', async () => {
  const { result } = await run(undefined);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'echo:hello');
  assert.ok(result.runId);
  assert.deepEqual(result.ext, { 'agent-plexus.hops': 1 });
});

test('the stack authorization governs the system: a denied member stops the run without detail', async () => {
  const { result } = await run('admin');
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.reason, { code: 'denied', layer: 'harness', by: 'agent-layers' });
  assert.doesNotMatch(JSON.stringify(result), /no rule matched|denied by rule/);
});

test('the stack guards govern the system', async () => {
  const { result } = await run('mail');
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'write to [EMAIL]');
});

test('the credential port mints the member token; the caller credential is not forwarded', async () => {
  seen.length = 0;
  const { result, records } = await run('token');
  assert.equal(result.status, 'completed');
  assert.equal(seen[0]?.credential, 'tok-billing');
  assert.equal(seen[0]?.caller, 'alice');
  assert.doesNotMatch(JSON.stringify(records), /alice-secret-credential|tok-billing/);
});

test('the system run uses the run id of the agent run', async () => {
  const { records, compose: composeOptions } = recorder();
  const stack = await compose(await loadConfig(config), composeOptions);
  try {
    const result = await (await stack.agent('desk')).run('hello', { caller: alice, runId: 'run-shared' });
    assert.equal(result.runId, 'run-shared');
    const runs = records.filter((r) => r.type === 'span' && r.name === 'plexus.run');
    assert.equal(runs.length, 1);
  } finally {
    await stack.close();
  }
});

test('risk and approve of the runtime go to the host it builds', async () => {
  const stack = await compose(await loadConfig(config, { profile: 'approve' }));
  try {
    const asked: AccessQuestion[] = [];
    const authorization = stack.ports.authorization!;
    const evaluate = authorization.evaluate.bind(authorization);
    authorization.evaluate = async (q, o) => { asked.push(q); return evaluate(q, o); };
    const result = await (await stack.agent('desk')).run('hello', { caller: alice });
    assert.equal(result.status, 'waiting');
    assert.equal(result.reason?.code, 'needs_input');
    assert.equal(asked[0]?.target.risk, 'write');
    assert.equal(asked[0]?.target.agent, 'desk');
  } finally {
    await stack.close();
  }
});

test('telemetry of the system goes through the stack with agent.layer', async () => {
  const { records } = await run(undefined);
  const plexus = records.filter((r) => r.name.startsWith('plexus.'));
  assert.ok(plexus.some((r) => r.name === 'plexus.hop'));
  assert.ok(plexus.every((r) => r.attrs['agent.layer'] === 'harness'));
  assert.ok(records.some((r) => r.name === 'agent.run'));
});

test('the system runs within the stack run bounds: deadline, hops, the reserved budget and the lineage', async () => {
  const stack = await compose(await loadConfig(config, { profile: 'token' }));
  try {
    seen.length = 0;
    const agentCaller: Caller = { ...alice, actors: [{ id: 'triage', kind: 'agent', issuer: 'https://idp.example' }] };
    const delegation = { remainingMs: 60_000, hops: 1, maxHops: 3, tokens: 500, costUsd: 0.5, rootRunId: 'root-1', parentRunId: 'parent-1' };
    const started = Date.now();
    const result = await (await stack.agent('desk')).run('hello', { caller: agentCaller, delegation, runId: 'run-b' });
    assert.equal(result.status, 'completed');
    const call = seen[0]!;
    assert.deepEqual(call.actors, agentCaller.actors);
    assert.deepEqual(call.lineage, { rootRunId: 'root-1', parentRunId: 'run-b' });
    assert.deepEqual([call.outbound.hops, call.outbound.maxHops, call.outbound.tokens, call.outbound.costUsd, call.outbound.rootRunId], [2, 3, 500, 0.5, 'root-1']);
    assert.ok(call.outbound.remainingMs <= 60_000 - (Date.now() - started), 'within the time the caller passed');
  } finally {
    await stack.close();
  }
});

test('the hop limit of the stack run stops the system before its member call', async () => {
  const stack = await compose(await loadConfig(config));
  try {
    const delegation = { remainingMs: 60_000, hops: 4, maxHops: 4, rootRunId: 'root-1', parentRunId: 'parent-1' };
    const result = await (await stack.agent('desk')).run('hello', { caller: alice, delegation });
    assert.equal(result.status, 'stopped');
    assert.deepEqual([result.reason?.code, result.reason?.layer], ['hop_limit', 'harness']);
  } finally {
    await stack.close();
  }
});

test('a system that cannot be assembled is a failed run with the error name only', async () => {
  const { result } = await run('broken');
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.reason, { code: 'error', layer: 'harness', by: 'agent-plexus', detail: 'ConfigError' });
});

test('layersReason: a plexus layer without an agent-layers equal is harness; stage and detail', () => {
  assert.deepEqual(layersReason({ code: 'timeout', layer: 'topology', by: 'x', detail: 'internal text' }), { code: 'timeout', layer: 'harness', by: 'x' });
  assert.deepEqual(layersReason({ code: 'guard_block', layer: 'guardrail', stage: 'send' }), { code: 'guard_block', layer: 'guardrail', stage: 'tool_args' });
  assert.deepEqual(layersReason({ code: 'guard_block', layer: 'host', stage: 'receive' }), { code: 'guard_block', layer: 'harness', stage: 'tool_result' });
  assert.deepEqual(layersReason({ code: 'guard_block', layer: 'member', memberLayer: 'guardrail' }), { code: 'guard_block', layer: 'guardrail' });
  assert.deepEqual(layersReason({ code: 'error', layer: 'member', memberLayer: 'not-a-layer' }), { code: 'error', layer: 'harness' });
});

test('runResultOf: status, output, usage and cost; hops as a count', () => {
  const mapped = runResultOf({
    status: 'completed', output: 'ok', runId: 'plexus-run', usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.25,
    record: [{ hopId: 'a', member: 'm', node: 'root', rootRunId: 'r', hops: 1, startedAt: '', durationMs: 1, status: 'completed' }],
  }, 'layers-run');
  assert.deepEqual(mapped, { runId: 'layers-run', status: 'completed', output: 'ok', usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.25, ext: { 'agent-plexus.hops': 1 } });
});
