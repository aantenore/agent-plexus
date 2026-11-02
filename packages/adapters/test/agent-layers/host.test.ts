import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccessQuestion, JsonValue, StoreEntry, StorePort } from '@agent-layers/core';
import { assemble, noopTelemetry, type Host } from '@agent-plexus/core';
import { adapters, hostAdapter, hostFromStack } from '../../src/agent-layers/index.ts';
import { seen } from './fixtures/members.ts';
import { checks } from './fixtures/spy-guard.ts';
import { alice, fixture, fixtures, plexusConfig, publicAlice } from './helpers.ts';

const caller = { ...alice, roles: [...alice.roles], scopes: [...alice.scopes] };

test('descriptors: host and member, both tiers', () => {
  assert.deepEqual(adapters.map((a) => [a.fills, a.name]), [['Host', 'agent-layers'], ['MemberPort', 'agent-layers']]);
  assert.deepEqual(hostAdapter.tiers, ['prototype', 'production']);
});

test('allow: a member the rules allow runs', async () => {
  const { system, stack } = await fixture();
  const result = await (await system(['billing'])).run('hello', { caller });
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'echo:hello');
  await stack.close();
});

test('deny: a denied member and an unmatched member are stopped as denied by the host', async () => {
  const { system, stack } = await fixture();
  const sys = await system(['admin']);
  const denied = await sys.run('hello', { caller });
  assert.equal(denied.status, 'stopped');
  assert.deepEqual([denied.reason?.code, denied.reason?.layer, denied.reason?.by], ['denied', 'host', 'agent-layers']);
  const unmatched = await (await system(['other'])).run('hello', { caller });
  assert.equal(unmatched.reason?.code, 'denied');
  await stack.close();
});

test('the access question carries the public caller, the member as target and the configured risk', async () => {
  const { system, stack } = await fixture({ agent: 'front-desk', risk: { billing: 'read' } });
  const asked: AccessQuestion[] = [];
  const authorization = stack.ports.authorization!;
  const evaluate = authorization.evaluate.bind(authorization);
  authorization.evaluate = async (q, o) => { asked.push(structuredClone(q)); return evaluate(q, o); };

  const sys = await system(['billing']);
  await sys.run('hello', { caller });
  await sys.run('hello');

  assert.deepEqual(asked[0], {
    caller: publicAlice,
    action: 'call',
    target: { kind: 'agent', id: 'billing', layer: 'harness', risk: 'read', agent: 'front-desk' },
  });
  assert.equal('credential' in asked[0]!.caller, false);
  assert.deepEqual(asked[1]!.caller, { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] });
  await stack.close();
});

test('the risk defaults to exec and the agent to the package default', async () => {
  const { system, stack } = await fixture();
  const asked: AccessQuestion[] = [];
  const authorization = stack.ports.authorization!;
  const evaluate = authorization.evaluate.bind(authorization);
  authorization.evaluate = async (q, o) => { asked.push(q); return evaluate(q, o); };
  await (await system(['billing'])).run('hello');
  assert.equal(asked[0]?.target.risk, 'exec');
  assert.equal(asked[0]?.target.agent, 'agent-plexus');
  await stack.close();
});

test('an authorization error is a deny', async () => {
  const { host, stack } = await fixture();
  stack.ports.authorization!.evaluate = async () => { throw new Error('backend down'); };
  const decision = await host.gate.allow({ runId: 'r1', action: 'invoke', member: { id: 'billing', name: 'billing', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } } });
  assert.equal(decision.effect, 'deny');
  assert.match(decision.reason ?? '', /authorization unavailable/);
  await stack.close();
});

test('production tier: the host is production-tier and no authorization adapter denies', async () => {
  const { host, system, stack } = await fixture({ profile: 'production' });
  assert.equal(host.tier, 'production');
  const result = await (await system(['billing'])).run('hello', { caller });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason?.code, 'denied');
  assert.match(result.reason?.detail ?? '', /no authorization adapter/);
  await stack.close();
});

test('prototype tier without an authorization adapter allows', async () => {
  const { host, stack } = await fixture();
  assert.equal(host.tier, 'prototype');
  delete stack.ports.authorization;
  const entry = { id: 'billing', name: 'billing', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } };
  assert.equal((await host.gate.allow({ runId: 'r1', action: 'invoke', member: entry })).effect, 'allow');
  await stack.close();
});

test('approval: asks while pending, allows once after approval, asks again afterwards', async () => {
  const { system, stack } = await fixture({ approve: ['audited'] });
  const approval = stack.ports.approval!;
  const sys = await system(['audited']);

  const first = await sys.run('hello', { caller, runId: 'run-1' });
  assert.equal(first.status, 'waiting');
  assert.equal(first.reason?.code, 'needs_input');
  const id = /approval pending: (.+)$/.exec(first.reason?.detail ?? '')?.[1];
  assert.ok(id);

  const again = await sys.run('hello', { caller, runId: 'run-1' });
  assert.match(again.reason?.detail ?? '', new RegExp(id!));

  await approval.decide(id!, { approved: true, by: 'bob' });
  const approved = await sys.run('hello', { caller, runId: 'run-1' });
  assert.equal(approved.status, 'completed');

  const next = await sys.run('hello', { caller, runId: 'run-1' });
  assert.equal(next.status, 'waiting');
  assert.doesNotMatch(next.reason?.detail ?? '', new RegExp(id!));
  await stack.close();
});

test('approval: a denied approval denies the call', async () => {
  const { system, stack } = await fixture({ approve: ['audited'] });
  const sys = await system(['audited']);
  const first = await sys.run('hello', { caller, runId: 'run-1' });
  const id = /approval pending: (.+)$/.exec(first.reason?.detail ?? '')?.[1]!;
  await stack.ports.approval!.decide(id, { approved: false, by: 'bob', reason: 'no' });
  const result = await sys.run('hello', { caller, runId: 'run-1' });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason?.code, 'denied');
  await stack.close();
});

test('approval: a member that needs approval without an approval adapter is denied', async () => {
  const { system, stack } = await fixture({ approve: ['audited'] });
  delete stack.ports.approval;
  const result = await (await system(['audited'])).run('hello', { caller });
  assert.equal(result.reason?.code, 'denied');
  await stack.close();
});

test('approval: keyed per run, an approval of one run does not allow another', async () => {
  const { system, stack } = await fixture({ approve: ['audited'] });
  const approval = stack.ports.approval!;
  const requests: { runId: string; key?: string }[] = [];
  const request = approval.request.bind(approval);
  approval.request = async (req) => { requests.push(req); return request(req); };
  const sys = await system(['audited']);

  const first = await sys.run('hello', { caller, runId: 'run-a' });
  const id = /approval pending: (.+)$/.exec(first.reason?.detail ?? '')?.[1]!;
  await approval.decide(id, { approved: true, by: 'bob' });

  const other = await sys.run('hello', { caller, runId: 'run-b' });
  assert.equal(other.status, 'waiting');
  assert.doesNotMatch(other.reason?.detail ?? '', new RegExp(id));
  assert.deepEqual(requests.map((r) => r.runId), ['run-a', 'run-b']);
  assert.notEqual(requests[0]?.key, requests[1]?.key);

  const same = await sys.run('hello', { caller, runId: 'run-a' });
  assert.equal(same.status, 'completed');
  await stack.close();
});

test('approval: keyed per caller, an approval of one caller does not allow another', async () => {
  const { host, system, stack } = await fixture({ approve: ['audited'] });
  const sys = await system(['audited']);
  const first = await sys.run('hello', { caller, runId: 'run-c' });
  const id = /approval pending: (.+)$/.exec(first.reason?.detail ?? '')?.[1]!;
  await stack.ports.approval!.decide(id, { approved: true, by: 'bob' });
  const audited = { id: 'audited', name: 'audited', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } };
  const asked = await host.gate.allow({ action: 'invoke', runId: 'run-c', caller: { ...publicAlice, id: 'bob' }, member: audited });
  assert.equal(asked.effect, 'ask');
  // Nor can another caller continue the run itself: only its owner may.
  const bob = await sys.run('hello', { caller: { ...caller, id: 'bob' }, runId: 'run-c' });
  assert.deepEqual([bob.status, bob.reason?.code, bob.reason?.layer], ['stopped', 'denied', 'host']);
  await stack.close();
});

test('the run id of the system reaches the guards and the result', async () => {
  const { system, stack } = await fixture({ approve: ['audited'] });
  const checked: string[] = [];
  const guard = stack.ports.guardrails[0]!;
  const check = guard.check.bind(guard);
  guard.check = async (input, opts) => { checked.push(input.runId); return check(input, opts); };
  const result = await (await system(['billing'])).run('hello', { caller, runId: 'run-d', sessionId: 'sess-1' });
  assert.equal(result.runId, 'run-d');
  assert.deepEqual([...new Set(checked)], ['run-d']);
  assert.ok(checked.length >= 2);
  await stack.close();
});

test('the guard context carries the run id and session of the check', async () => {
  const { host, stack } = await fixture();
  const seenRuns: string[] = [];
  const guard = stack.ports.guardrails[0]!;
  const check = guard.check.bind(guard);
  guard.check = async (input, opts) => { seenRuns.push(input.runId); return check(input, opts); };
  const member = { id: 'billing', name: 'billing', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } };
  await host.gate.check({ stage: 'send', text: 'x', member, runId: 'run-e', sessionId: 's-2' });
  assert.deepEqual(seenRuns, ['run-e']);
  await stack.close();
});

test('an approval request never carries the caller credential', async () => {
  const { system, stack } = await fixture({ approve: ['audited'] });
  const approval = stack.ports.approval!;
  const requests: unknown[] = [];
  const request = approval.request.bind(approval);
  approval.request = async (req) => { requests.push(req); return request(req); };
  await (await system(['audited'])).run('hello', { caller });
  assert.ok(requests.length > 0);
  assert.doesNotMatch(JSON.stringify(requests), /alice-secret-credential/);
  await stack.close();
});

test('guard: a block on what is sent sets the stage in the hop record', async () => {
  const { system, stack } = await fixture();
  const result = await (await system(['billing'])).run('please NOSEND this', { caller });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason?.code, 'guard_block');
  assert.equal(result.reason?.layer, 'host');
  assert.equal(result.reason?.stage, 'send');
  assert.equal(result.record[0]?.reason?.stage, 'send');
  assert.match(result.reason?.detail ?? '', /no-send/);
  await stack.close();
});

test('guard: a block on what comes back sets the stage in the hop record', async () => {
  const { system, stack } = await fixture();
  const result = await (await system(['leaky'])).run('hello', { caller });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason?.code, 'guard_block');
  assert.equal(result.record[0]?.reason?.stage, 'receive');
  assert.match(result.record[0]?.reason?.detail ?? '', /no-receive/);
  await stack.close();
});

test('guard: a redaction replaces the text that goes on, in both directions', async () => {
  const { system, stack } = await fixture();
  const sent = await (await system(['billing'])).run('mail jane@example.com', { caller });
  assert.equal(sent.output, 'echo:mail [EMAIL]');
  const received = await (await system(['mailer'])).run('hello', { caller });
  assert.equal(received.output, 'write to [EMAIL]');
  await stack.close();
});

test('guard: a stage-limited guard does not run at the other stage', async () => {
  const { system, stack } = await fixture();
  const result = await (await system(['mailer'])).run('NORECEIVE is only checked on the way back', { caller });
  assert.equal(result.status, 'completed');
  await stack.close();
});

test('guard: a failing guard blocks without echoing its error', async () => {
  const { host, stack } = await fixture();
  stack.ports.guardrails[0]!.check = async () => { throw new Error('secret backend detail'); };
  const verdict = await host.gate.check({ runId: 'r1', stage: 'send', text: 'x', member: { id: 'billing', name: 'billing', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } } });
  assert.equal(verdict.action, 'block');
  assert.doesNotMatch(verdict.reason ?? '', /secret backend detail/);
  await stack.close();
});

test('token: the credential port mints a token for the audience, never the caller credential', async () => {
  const { system, host, stack, records } = await fixture();
  seen.length = 0;
  const result = await (await system(['tokened'])).run('hello', { caller });
  assert.equal(result.status, 'completed');
  assert.equal(seen[0]?.credential, 'tok-billing');
  assert.equal(seen[0]?.caller, 'alice');
  assert.notEqual(seen[0]?.credential, alice.credential);
  assert.doesNotMatch(JSON.stringify(records), /alice-secret-credential|tok-billing/);
  assert.equal(await host.gate.token(undefined, 'https://billing.example'), 'tok-billing');
  await stack.close();
});

test('token: no credential port, no token', async () => {
  const { host, stack } = await fixture();
  delete stack.ports.credentials;
  assert.equal(await host.gate.token(caller, 'https://billing.example'), undefined);
  await stack.close();
});

test('token: an audience without a token is needs_auth', async () => {
  const { host, stack } = await fixture();
  await assert.rejects(host.gate.token(caller, 'https://unknown.example'), /no token for audience/);
  await stack.close();
});

test('telemetry: every record carries agent.layer and keeps the plexus attributes', async () => {
  const { system, host, stack, records } = await fixture();
  await (await system(['billing'])).run('hello', { caller });
  host.telemetry.event('plexus.limit', { 'plexus.layer': 'topology' });
  host.telemetry.metric('plexus.hops', 1, { 'plexus.layer': 'member' });

  const plexus = records.filter((r) => r.name.startsWith('plexus.'));
  assert.ok(plexus.length >= 3);
  for (const r of plexus) {
    assert.equal(r.attrs['agent.layer'], 'harness', r.name);
    assert.ok(typeof r.attrs['plexus.layer'] === 'string', r.name);
  }
  const hop = records.find((r) => r.type === 'span' && r.name === 'plexus.hop');
  assert.equal(hop?.attrs['plexus.member'], 'billing');
  assert.ok(records.some((r) => r.type === 'event' && r.name === 'plexus.limit'));
  assert.ok(records.some((r) => r.type === 'metric' && r.name === 'plexus.hops' && r.value === 1));
  await stack.close();
});

test('telemetry: span handle sets attributes and events', async () => {
  const { host, stack, records } = await fixture();
  const out = await host.telemetry.span('plexus.test', { 'plexus.layer': 'topology' }, async (span) => {
    span.set({ 'plexus.run.status': 'completed' });
    span.event('plexus.note', { 'plexus.layer': 'topology' });
    return 42;
  });
  assert.equal(out, 42);
  const span = records.find((r) => r.type === 'span' && r.name === 'plexus.test');
  assert.equal(span?.type === 'span' && span.attrs['plexus.run.status'], 'completed');
  assert.equal(span?.type === 'span' && span.events[0]?.name, 'plexus.note');
  await stack.close();
});

test('score: the stack evaluators score the case and map back to plexus scores', async () => {
  const { system, host, stack } = await fixture();
  assert.ok(host.score);
  const sys = await system(['billing']);
  const result = await sys.run('hello', { caller });
  const hit = await host.score!.score({ id: 'c1', input: 'hello', expected: { output: { equals: 'echo:hello' } } }, result);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.metric, 'expected');
  assert.equal(hit[0]?.value, 1);
  const miss = await host.score!.score({ id: 'c2', input: 'hello', expected: { output: { equals: 'other' } } }, result);
  assert.equal(miss[0]?.value, 0);
  assert.ok(miss[0]?.reason);
  assert.deepEqual(await host.score!.score({ id: 'c3', input: 'hello' }, result), []);
  await stack.close();
});

test('score: expectations on members are checked on the texts the core reads back', async () => {
  const { system, stack } = await fixture();
  const sys = await system(['billing']);
  const result = await sys.run('hello', { caller });
  const scores = await sys.score({ id: 'c1', input: 'hello', expected: { members: { billing: { contains: 'echo:hello', status: 'completed' } } } }, result);
  assert.deepEqual(scores.map((s) => [s.metric, s.value]), [['expected.member', 1]]);
  const miss = await sys.score({ id: 'c2', input: 'hello', expected: { members: { billing: { contains: 'other' } } } }, result);
  assert.deepEqual(miss.map((s) => [s.metric, s.value]), [['expected.member', 0]]);
  await stack.close();
});

test('score: absent without evaluators; state absent without a store', async () => {
  const { stack } = await fixture();
  stack.ports.eval.length = 0;
  const host = hostFromStack(stack);
  assert.equal(host.score, undefined);
  assert.equal(host.state, undefined);
  await stack.close();
});

/** A StorePort kept in a map, enough for the state hook: versions grow with every write. */
function mapStore(): StorePort & { entries: Map<string, StoreEntry> } {
  const entries = new Map<string, StoreEntry>();
  return {
    entries,
    async get(key) { return entries.get(key); },
    async set(key, value: JsonValue, opts = {}) {
      const current = entries.get(key)?.version;
      if (opts.ifVersion !== undefined && opts.ifVersion !== (current ?? 0)) return { ok: false, ...(current ? { version: current } : {}) };
      const version = (current ?? 0) + 1;
      entries.set(key, { value, version });
      return { ok: true, version };
    },
    async delete(key) { return { ok: true, existed: entries.delete(key) }; },
  };
}

test('state: get, set and delete on the stack store, keys under plexus.', async () => {
  const { stack } = await fixture();
  const store = mapStore();
  stack.ports.store = store;
  const { state } = hostFromStack(stack);
  assert.ok(state);
  assert.equal(await state.get('cursor'), undefined);
  await state.set('cursor', { page: 2, seen: ['a'] });
  assert.deepEqual([...store.entries.keys()], ['plexus.cursor']);
  assert.deepEqual(await state.get('cursor'), { page: 2, seen: ['a'] });
  await state.delete('cursor');
  assert.equal(await state.get('cursor'), undefined);
  // A write the store refuses is an error.
  store.set = async () => ({ ok: false, version: 3 });
  await assert.rejects(state.set('cursor', 1), /refused the write of plexus\.cursor/);
  await stack.close();
});

test('configured host: the adapter composes the stack and plexus assembles with it', async () => {
  const config = await plexusConfig(['billing', 'assistant'], { host: { adapter: 'agent-layers', options: { config: './layers.json' } } });
  const system = await assemble(config, { cwd: fixtures });
  assert.equal(system.tier, 'prototype');
  const result = await system.run('ping', { caller });
  assert.equal(result.status, 'completed');
  assert.equal(result.record.length, 2);
  const findings = await system.check();
  assert.deepEqual(findings.filter((f) => f.severity === 'fail'), []);
  await system.close();
});

test('configured host: the agent defaults to the system name and an option wins', async () => {
  const ctx = (system: string) => ({ system, name: 'host', cwd: fixtures, env: {}, telemetry: noopTelemetry });
  const member = { id: 'billing', name: 'billing', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } };
  checks.length = 0;
  for (const [system, options] of [['desk', {}], ['desk', { agent: 'front-desk' }]] as const) {
    const host = await hostAdapter.create({ config: './layers-spy.json', ...options }, ctx(system)) as Host & { close(): Promise<void> };
    await host.gate.check({ stage: 'send', text: 'x', member, runId: 'run-f' });
    await host.close();
  }
  assert.deepEqual(checks.map((c) => [c.agent, c.runId]), [['desk', 'run-f'], ['front-desk', 'run-f']]);
});

test('configured host: invalid options are refused', async () => {
  const config = await plexusConfig(['billing'], { host: { adapter: 'agent-layers', options: {} } });
  await assert.rejects(assemble(config, { cwd: fixtures }), /config/);
});

test('resume: only the run owner may resume; the owner is asked as action resume about the waiting member', async () => {
  const { host, stack } = await fixture({ risk: { billing: 'read' } });
  const asked: AccessQuestion[] = [];
  const authorization = stack.ports.authorization!;
  const evaluate = authorization.evaluate.bind(authorization);
  authorization.evaluate = async (q, o) => { asked.push(structuredClone(q)); return evaluate(q, o); };
  const member = { id: 'billing', name: 'billing', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } };
  const owner = { id: 'alice', kind: 'user' as const };
  const mallory = { id: 'mallory', kind: 'user' as const, roles: ['staff'], scopes: [] };

  const stolen = await host.gate.allow({ action: 'resume', runId: 'r1', caller: mallory, owner, member });
  assert.deepEqual(stolen, { effect: 'deny', reason: 'only the caller that started the run may resume it' });
  assert.equal((await host.gate.allow({ action: 'resume', runId: 'r1', owner, member })).effect, 'deny');
  assert.equal(asked.length, 0, 'a resume by someone else never reaches the policy');

  assert.equal((await host.gate.allow({ action: 'resume', runId: 'r1', caller: publicAlice, owner, member })).effect, 'allow');
  assert.deepEqual(asked[0], {
    caller: publicAlice,
    action: 'resume',
    target: { kind: 'agent', id: 'billing', layer: 'harness', risk: 'read', agent: 'agent-plexus' },
    ext: { 'agent-plexus.owner': { id: 'alice', kind: 'user' } },
  });
  // A run that waits on no member is asked about as the run itself; these rules know no such target and deny it.
  assert.equal((await host.gate.allow({ action: 'resume', runId: 'r2' })).effect, 'deny');
  assert.deepEqual(asked[1]?.target, { kind: 'run', id: 'r2', layer: 'harness', risk: 'exec', agent: 'agent-plexus' });

  authorization.evaluate = async (q) => ({ allowed: q.action !== 'resume', reason: 'no resumes' });
  assert.deepEqual(await host.gate.allow({ action: 'resume', runId: 'r1', caller: publicAlice, owner, member }), { effect: 'deny', reason: 'no resumes' });
  assert.equal((await host.gate.allow({ action: 'invoke', runId: 'r1', caller: publicAlice, member })).effect, 'allow');
  await stack.close();
});

test('cancel: only the run owner may cancel; the owner is asked as action cancel about the waiting member', async () => {
  const { host, stack } = await fixture({ risk: { billing: 'read' } });
  const asked: AccessQuestion[] = [];
  const authorization = stack.ports.authorization!;
  const evaluate = authorization.evaluate.bind(authorization);
  authorization.evaluate = async (q, o) => { asked.push(structuredClone(q)); return evaluate(q, o); };
  const member = { id: 'billing', name: 'billing', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } };
  const owner = { id: 'alice', kind: 'user' as const };
  const mallory = { id: 'mallory', kind: 'user' as const, roles: ['staff'], scopes: [] };

  assert.deepEqual(await host.gate.allow({ action: 'cancel', runId: 'r1', caller: mallory, owner, member }), { effect: 'deny', reason: 'only the caller that started the run may cancel it' });
  assert.equal(asked.length, 0, 'a cancel by someone else never reaches the policy');

  await host.gate.allow({ action: 'cancel', runId: 'r1', caller: publicAlice, owner, member });
  assert.deepEqual(asked[0], {
    caller: publicAlice,
    action: 'cancel',
    target: { kind: 'agent', id: 'billing', layer: 'harness', risk: 'read', agent: 'agent-plexus' },
    ext: { 'agent-plexus.owner': { id: 'alice', kind: 'user' } },
  });
  authorization.evaluate = async (q) => ({ allowed: q.action !== 'cancel', reason: 'no cancels' });
  assert.deepEqual(await host.gate.allow({ action: 'cancel', runId: 'r1', caller: publicAlice, owner, member }), { effect: 'deny', reason: 'no cancels' });
  await stack.close();
});

test('resume with an answer: the approval is decided by the resuming owner, then the call goes on once', async () => {
  const { system, stack } = await fixture({ approve: ['audited'] });
  const approval = stack.ports.approval!;
  const sys = await system(['audited']);
  const first = await sys.run('hello', { runId: 'answered', caller });
  const id = /approval pending: (.+)$/.exec(first.reason?.detail ?? '')?.[1]!;
  assert.equal(first.wait?.kind, 'approval');

  const resumed = await sys.resume('answered', { approved: true, reason: 'fine', wait: first.wait!.token }, { caller });
  assert.deepEqual([resumed.status, resumed.output], ['completed', 'echo:hello']);
  const decided = await approval.get(id);
  assert.deepEqual([decided?.status, decided?.decidedBy, decided?.reason], ['approved', 'alice', 'fine']);
  // Consumed: the approval let one call through, so a new run of the same id asks again.
  assert.equal((await sys.run('hello', { runId: 'answered', caller })).status, 'waiting');
  await stack.close();
});

test('resume with an answer: a denial is recorded with the resuming owner and denies the call', async () => {
  const { system, stack } = await fixture({ approve: ['audited'] });
  const sys = await system(['audited']);
  const first = await sys.run('hello', { runId: 'refused', caller });
  const id = /approval pending: (.+)$/.exec(first.reason?.detail ?? '')?.[1]!;
  const resumed = await sys.resume('refused', { approved: false, reason: 'no' }, { caller });
  assert.deepEqual([resumed.status, resumed.reason?.code, resumed.reason?.layer], ['stopped', 'denied', 'host']);
  const decided = await stack.ports.approval!.get(id);
  assert.deepEqual([decided?.status, decided?.decidedBy], ['denied', 'alice']);
  await stack.close();
});

test('resume with an answer: a decision taken elsewhere first stands; without lookup the id is unknown', async () => {
  const { host, stack } = await fixture({ approve: ['audited'] });
  const approval = stack.ports.approval!;
  const audited = { id: 'audited', name: 'audited', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } };
  const invoke = (runId: string, answer?: { approved: boolean; by?: string }) => host.gate.allow({ action: 'invoke', runId, caller: publicAlice, member: audited, ...(answer ? { answer } : {}) });

  const asked = await invoke('elsewhere');
  const id = /approval pending: (.+)$/.exec(asked.reason ?? '')?.[1]!;
  await approval.decide(id, { approved: false, by: 'bob' });
  assert.deepEqual(await invoke('elsewhere', { approved: true, by: 'alice' }), { effect: 'deny', reason: 'approval denied' });
  assert.equal((await approval.get(id))?.decidedBy, 'bob');

  delete approval.lookup;
  assert.equal((await invoke('no-lookup', { approved: true, by: 'alice' })).effect, 'ask');
  assert.deepEqual(await invoke('no-lookup', { approved: false, by: 'alice' }), { effect: 'deny', reason: 'approval denied by alice' });
  await stack.close();
});

test('resume through a system: a caller other than the owner is denied by the host before anything is delivered', async () => {
  const { system, stack } = await fixture({ approve: ['audited'] });
  const sys = await system(['audited']);
  const first = await sys.run('hello', { runId: 'owned', caller });
  assert.equal(first.status, 'waiting');
  const stolen = await sys.resume('owned', { approved: true }, { caller: { id: 'mallory', kind: 'user', roles: ['staff'], scopes: [] } });
  assert.deepEqual([stolen.status, stolen.reason?.code, stolen.reason?.layer, stolen.reason?.by], ['stopped', 'denied', 'host', 'agent-layers']);
  await stack.close();
});
