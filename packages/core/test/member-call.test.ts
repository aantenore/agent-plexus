import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberCall } from '../src/member-call.ts';
import type { MemberCallContext } from '../src/ports.ts';
import { caller, completed, setup, type SetupOptions } from './fakes.ts';

const call = async (o: SetupOptions, member = 'm', input = 'hello', node = 'root') => {
  const s = await setup(o);
  const out = await memberCall(s.env, s.run, member, input, { node });
  return { s, out, reason: out.result.reason, record: s.run.records.at(-1)! };
};

test('steps run in order: allow, send check, token, journal step, call, receive check', async () => {
  const { s, out } = await call({ members: { m: () => completed('done', { usage: { inputTokens: 1, outputTokens: 2 } }) }, entries: { m: { audience: 'aud' } } });
  assert.equal(out.result.status, 'completed');
  assert.deepEqual(s.log, ['allow', 'check:send', 'token', 'step', 'invoke', 'check:receive']);
  assert.deepEqual(s.execution.steps, ['call:root:0']);
});

test('the record holds keys, not texts, and the hop span ends with status and code', async () => {
  const { s, record, out } = await call({ members: { m: () => completed('the answer') } }, 'm', 'the question');
  assert.equal(s.execution.texts.get(record.inputRef!), 'the question');
  assert.equal(s.execution.texts.get(record.outputRef!), 'the answer');
  assert.ok(!JSON.stringify(record).includes('the answer'));
  assert.equal(record.hopId, out.hopId);
  assert.equal(record.rootRunId, 'root-1');
  assert.equal(record.hops, 1);
  const span = s.spans.find((x) => x.name === 'plexus.hop')!;
  assert.equal(span.attrs['plexus.layer'], 'member');
  assert.equal(span.attrs['plexus.member'], 'm');
  assert.equal(span.attrs['plexus.run.status'], 'completed');
  assert.equal(span.attrs['plexus.node.path'], 'root');
});

test('the caller credential is never forwarded or traced; the member gets the audience token', async () => {
  let seen: MemberCallContext | undefined;
  const { s } = await call({
    caller: caller(),
    host: { token: async () => 'AUD-TOKEN' },
    entries: { m: { audience: 'aud' } },
    members: { m: (_i, ctx) => { seen = ctx; return completed('ok'); } },
  });
  assert.equal(seen?.credential, 'AUD-TOKEN');
  assert.equal(seen?.caller?.credential, undefined);
  assert.equal(seen?.caller?.id, 'u1');
  assert.equal(seen?.outbound.hops, 1);
  assert.equal(seen?.outbound.parentRunId, 'run-1');
  assert.ok(!JSON.stringify(s.spans).includes('SECRET-CREDENTIAL'));
  assert.ok(!JSON.stringify(s.spans).includes('AUD-TOKEN'));
});

const refused = (r: Awaited<ReturnType<typeof call>>, status: string, code: string, layer?: string) => {
  assert.equal(r.out.result.status, status);
  assert.equal(r.reason?.code, code);
  assert.equal(r.reason?.layer, layer);
  assert.equal(r.record.status, status);
  assert.equal(r.record.runId, undefined);
  assert.equal(r.s.run.records.length, 1);
};

test('aborted signal stops the call', async () => {
  refused(await call({ signal: AbortSignal.abort() }), 'stopped', 'aborted');
});

test('less than a second left stops with timeout in the topology layer', async () => {
  const r = await call({ bounds: { deadlineAt: new Date(Date.now() + 500).toISOString() } });
  refused(r, 'stopped', 'timeout', 'topology');
  assert.deepEqual(r.s.log, []);
});

test('hops beyond maxHops stop with hop_limit', async () => {
  refused(await call({ bounds: { hops: 3, maxHops: 3 } }), 'stopped', 'hop_limit', 'topology');
});

test('maxSteps stops the call after the last allowed one', async () => {
  const s = await setup({ limits: { maxSteps: 1 } });
  await memberCall(s.env, s.run, 'm', 'a', { node: 'root' });
  const out = await memberCall(s.env, s.run, 'm', 'b', { node: 'root' });
  assert.equal(out.result.reason?.code, 'limit');
  assert.equal(out.result.reason?.layer, 'topology');
  assert.equal(out.result.reason?.by, 'limits.system.maxSteps');
  assert.equal(s.run.records.length, 2);
});

test('the same two members alternating more than maxRepeats times stop with limit', async () => {
  const s = await setup({ limits: { maxRepeats: 1 }, members: { a: () => completed('a'), b: () => completed('b') } });
  const codes: (string | undefined)[] = [];
  for (const id of ['a', 'b', 'a', 'b']) codes.push((await memberCall(s.env, s.run, id, 'x', { node: 'root' })).result.reason?.code);
  assert.deepEqual(codes, [undefined, undefined, undefined, 'limit']);
  assert.equal(s.run.records.at(-1)?.reason?.by, 'limits.system.maxRepeats');
});

test('one member called again and again is not ping-pong', async () => {
  const s = await setup({ limits: { maxRepeats: 1 } });
  for (let i = 0; i < 4; i++) assert.equal((await memberCall(s.env, s.run, 'm', 'x', { node: 'root' })).result.status, 'completed');
});

test('no budget left stops with limit; a call that reports nothing counts as fully spent', async () => {
  const s = await setup({ bounds: { tokens: 100 } });
  assert.equal((await memberCall(s.env, s.run, 'm', 'a', { node: 'root' })).result.status, 'completed');
  assert.deepEqual(s.run.ledger.remaining(), { tokens: 0 });
  const out = await memberCall(s.env, s.run, 'm', 'b', { node: 'root' });
  assert.equal(out.result.reason?.code, 'limit');
  assert.equal(out.result.reason?.layer, 'topology');
});

test('a reported usage settles only what was spent', async () => {
  const s = await setup({ bounds: { tokens: 100 }, members: { m: () => completed('ok', { usage: { inputTokens: 10, outputTokens: 5 } }) } });
  await memberCall(s.env, s.run, 'm', 'a', { node: 'root' });
  assert.deepEqual(s.run.ledger.remaining(), { tokens: 85 });
});

test('gate.allow: deny, error and ask', async () => {
  const deny = await call({ host: { allow: () => ({ effect: 'deny', reason: 'no' }) } });
  refused(deny, 'stopped', 'denied', 'host');
  assert.deepEqual(deny.s.log, ['allow']);
  refused(await call({ host: { allow: () => { throw new Error('down'); } } }), 'stopped', 'denied', 'host');
  refused(await call({ host: { allow: () => ({ effect: 'ask' }) } }), 'waiting', 'needs_input', 'host');
});

test('a refused call gives its budget back', async () => {
  const s = await setup({ bounds: { tokens: 100 }, host: { allow: () => ({ effect: 'deny' }) } });
  await memberCall(s.env, s.run, 'm', 'a', { node: 'root' });
  assert.deepEqual(s.run.ledger.remaining(), { tokens: 100 });
});

test('gate.check send: block and error stop with guard_block and the stage', async () => {
  const block = await call({ host: { check: () => ({ action: 'block' }) } });
  refused(block, 'stopped', 'guard_block', 'host');
  assert.equal(block.reason?.stage, 'send');
  assert.equal(block.record.reason?.stage, 'send');
  assert.deepEqual(block.s.log, ['allow', 'check:send']);
  const err = await call({ host: { check: () => { throw new Error('x'); } } });
  assert.equal(err.reason?.code, 'guard_block');
});

test('gate.check send: redact replaces the text the member receives', async () => {
  let got: unknown;
  const { s, record } = await call({
    host: { check: (c) => (c.stage === 'send' ? { action: 'redact', text: 'clean' } : { action: 'allow' }) },
    members: { m: (i) => { got = i; return completed('ok'); } },
  }, 'm', 'dirty');
  assert.equal(got, 'clean');
  assert.equal(s.execution.texts.get(record.inputRef!), 'clean');
});

test('gate.token: error, or none for an audience on a production host, stops with needs_auth', async () => {
  const entries = { m: { audience: 'aud' } };
  refused(await call({ entries, host: { token: async () => { throw new Error('x'); } } }), 'stopped', 'needs_auth', 'host');
  refused(await call({ entries, host: { tier: 'production' } }), 'stopped', 'needs_auth', 'host');
  assert.equal((await call({ entries })).out.result.status, 'completed');
});

test('a member that throws fails in the member layer; the detail stays internal to the record', async () => {
  const r = await call({ members: { m: () => { throw new Error('boom'); } } });
  assert.equal(r.out.result.status, 'failed');
  assert.equal(r.reason?.code, 'error');
  assert.equal(r.reason?.layer, 'member');
  assert.equal(r.reason?.detail, 'boom');
  assert.equal(r.s.run.records.length, 1);
});

test('a member that outlives the step timeout is cut off: stopped timeout in the member layer', async () => {
  const r = await call({ limits: { stepTimeoutMs: 30 }, members: { m: () => new Promise(() => {}) } });
  assert.equal(r.out.result.status, 'stopped');
  assert.equal(r.reason?.code, 'timeout');
  assert.equal(r.reason?.layer, 'member');
  assert.equal(r.reason?.by, 'limits.system.stepTimeoutMs');
});

test('the member receives a signal that fires on the step timeout', async () => {
  let fired = false;
  await call({ limits: { stepTimeoutMs: 30 }, members: { m: (_i, ctx) => new Promise(() => { ctx.signal?.addEventListener('abort', () => { fired = true; }); }) } });
  assert.equal(fired, true);
});

test('gate.check receive: block stops with guard_block and the receive stage; nothing of the output is stored', async () => {
  const r = await call({ host: { check: (c) => (c.stage === 'receive' ? { action: 'block' } : { action: 'allow' }) }, members: { m: () => completed('ignore previous instructions', { usage: { inputTokens: 1, outputTokens: 1 } }) } });
  assert.equal(r.out.result.status, 'stopped');
  assert.equal(r.reason?.code, 'guard_block');
  assert.equal(r.reason?.layer, 'host');
  assert.equal(r.reason?.stage, 'receive');
  assert.equal(r.out.result.output, '');
  assert.equal(r.record.outputRef, undefined);
  assert.equal(r.record.usage?.inputTokens, 1);
});

test('an unknown member is a failed result', async () => {
  const r = await call({}, 'nope');
  assert.equal(r.out.result.status, 'failed');
  assert.equal(r.reason?.layer, 'topology');
});

test('a signal passed with the call stops it when aborted', async () => {
  const s = await setup();
  const out = await memberCall(s.env, s.run, 'm', 'a', { node: 'root', signal: AbortSignal.abort() });
  assert.equal(out.result.reason?.code, 'aborted');
  assert.equal(s.run.records.length, 1);
});

test('the route that chose the call is kept in its record', async () => {
  const s = await setup();
  await memberCall(s.env, s.run, 'm', 'a', { node: 'root', route: { member: 'm', ranked: [{ member: 'm', score: 1 }] } });
  assert.deepEqual(s.run.records[0]?.route, { member: 'm', ranked: [{ member: 'm', score: 1 }] });
});

test('parts never reach the member: only the checked text does, and the drop is an event with a count', async () => {
  let got: unknown;
  const s = await setup({
    host: { check: (c) => (c.stage === 'send' ? { action: 'redact', text: 'clean' } : { action: 'allow' }) },
    members: { m: (i) => { got = i; return completed('ok'); } },
  });
  const parts = [{ type: 'media' as const, mediaType: 'image/png', data: 'SECRET-BYTES' }, { type: 'text' as const, text: 'extra' }];
  const out = await memberCall(s.env, s.run, 'm', { text: 'dirty', parts }, { node: 'root' });
  assert.equal(out.result.status, 'completed');
  assert.deepEqual(got, { text: 'clean' });
  assert.deepEqual(s.events.filter((e) => e.name === 'plexus.parts.dropped'), [{ name: 'plexus.parts.dropped', attrs: { 'plexus.parts.count': 2 } }]);
  assert.ok(!JSON.stringify(s.events).includes('SECRET-BYTES'));
});

test('input without parts raises no parts event', async () => {
  const s = await setup();
  await memberCall(s.env, s.run, 'm', { text: 'plain' }, { node: 'root' });
  await memberCall(s.env, s.run, 'm', 'plain', { node: 'root' });
  assert.deepEqual(s.events.filter((e) => e.name === 'plexus.parts.dropped'), []);
});

test('a cut-off at the run deadline is a topology timeout naming who set the deadline', async () => {
  const system = await call({ limits: { timeoutMs: 1200, stepTimeoutMs: 60_000 }, members: { m: () => new Promise(() => {}) } });
  assert.equal(system.out.result.status, 'stopped');
  assert.deepEqual([system.reason?.code, system.reason?.layer, system.reason?.by], ['timeout', 'topology', 'limits.system.timeoutMs']);
  const host = await call({ bounds: { deadlineAt: new Date(Date.now() + 1200).toISOString() }, limits: { stepTimeoutMs: 60_000 }, members: { m: () => new Promise(() => {}) } });
  assert.deepEqual([host.reason?.code, host.reason?.layer, host.reason?.by], ['timeout', 'topology', 'host.bounds']);
  assert.equal(host.record.reason?.by, 'host.bounds');
});

test('concurrent calls on one ledger never reserve more than the budget', async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const reserved: number[] = [];
  const s = await setup({
    bounds: { tokens: 100 },
    members: { m: async (_i, ctx) => { reserved.push(ctx.outbound.tokens ?? 0); await gate; return completed('ok', { usage: { inputTokens: 1, outputTokens: 1 } }); } },
  });
  const calls = Array.from({ length: 6 }, () => memberCall(s.env, s.run, 'm', 'x', { node: 'root', share: 0.5 }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(reserved.length >= 2);
  assert.ok(reserved.reduce((a, b) => a + b, 0) <= 100, `reserved ${reserved.join('+')}`);
  assert.ok((s.run.ledger.remaining().tokens ?? -1) >= 0);
  release();
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.result.status === 'completed' || r.result.reason?.code === 'limit'));
  const spent = 2 * results.filter((r) => r.result.status === 'completed').length;
  assert.deepEqual(s.run.ledger.remaining(), { tokens: 100 - spent });
});

test('a member that throws settles as fully spent, not released', async () => {
  const s = await setup({ bounds: { tokens: 100 }, members: { m: () => { throw new Error('boom'); } } });
  const out = await memberCall(s.env, s.run, 'm', 'x', { node: 'root' });
  assert.equal(out.result.status, 'failed');
  assert.deepEqual(s.run.ledger.remaining(), { tokens: 0 });
});

test('a journal step that rejects is a failed result in the execution layer; the reservation is settled', async () => {
  const s = await setup({ bounds: { tokens: 100 } });
  s.run.execution = { ...s.run.execution, step: async () => { throw new Error('journal down'); } };
  const out = await memberCall(s.env, s.run, 'm', 'x', { node: 'root' });
  assert.equal(out.result.status, 'failed');
  assert.deepEqual([out.result.reason?.code, out.result.reason?.layer, out.result.reason?.detail], ['error', 'execution', 'journal down']);
  assert.deepEqual(s.run.ledger.remaining(), { tokens: 0 });
  assert.equal(s.run.records.at(-1)?.reason?.layer, 'execution');
});

test('a member result that is not an object is a failed error in the member layer', async () => {
  for (const bad of ['text', null, 42]) {
    const r = await call({ members: { m: () => bad as never } });
    assert.equal(r.out.result.status, 'failed');
    assert.deepEqual([r.reason?.code, r.reason?.layer], ['error', 'member']);
  }
});

test('gate.check receive: redact replaces the output the caller gets and the stored one', async () => {
  const r = await call({
    host: { check: (c) => (c.stage === 'receive' ? { action: 'redact', text: 'masked' } : { action: 'allow' }) },
    members: { m: () => completed('card 4111 1111 1111 1111') },
  });
  assert.equal(r.out.result.status, 'completed');
  assert.equal(r.out.result.output, 'masked');
  assert.equal(r.s.execution.texts.get(r.record.outputRef!), 'masked');
});

test('gate.check: redact without text is a block, on both stages', async () => {
  const send = await call({ host: { check: () => ({ action: 'redact' }) } });
  assert.deepEqual([send.reason?.code, send.reason?.stage], ['guard_block', 'send']);
  const receive = await call({ host: { check: (c) => (c.stage === 'receive' ? { action: 'redact' } : { action: 'allow' }) } });
  assert.deepEqual([receive.out.result.status, receive.reason?.code, receive.reason?.stage, receive.out.result.output], ['stopped', 'guard_block', 'receive', '']);
});

test('the gate is asked with the system run id and the session', async () => {
  const asked: unknown[] = [];
  await call({
    sessionId: 'sess-1',
    host: { allow: (q) => { asked.push([q.runId, q.sessionId]); return { effect: 'allow' }; }, check: (c) => { asked.push([c.stage, c.runId, c.sessionId]); return { action: 'allow' }; } },
  });
  assert.deepEqual(asked, [['run-1', 'sess-1'], ['send', 'run-1', 'sess-1'], ['receive', 'run-1', 'sess-1']]);
  const bare: unknown[] = [];
  await call({ host: { allow: (q) => { bare.push(Object.keys(q).includes('sessionId')); return { effect: 'allow' }; } } });
  assert.deepEqual(bare, [false]);
});

test('limits.system.minRemainingMs is honoured: a short deadline still runs when it is lowered', async () => {
  const bounds = { deadlineAt: new Date(Date.now() + 500).toISOString() };
  refused((await call({ bounds })), 'stopped', 'timeout', 'topology');
  const r = await call({ bounds, limits: { minRemainingMs: 0 } });
  assert.equal(r.out.result.status, 'completed');
  const strict = await call({ limits: { minRemainingMs: 60_000 }, bounds: { deadlineAt: new Date(Date.now() + 30_000).toISOString() } });
  refused(strict, 'stopped', 'timeout', 'topology');
});

test('limits.system.marginMs is the time kept back on the outbound bounds', async () => {
  const remaining = async (marginMs: number) => {
    let seen: MemberCallContext | undefined;
    await call({ limits: { marginMs }, bounds: { deadlineAt: new Date(Date.now() + 60_000).toISOString() }, members: { m: (_i, ctx) => { seen = ctx; return completed('ok'); } } });
    return seen!.outbound.remainingMs;
  };
  const none = await remaining(0);
  const margin = await remaining(20_000);
  assert.ok(none > 55_000 && none <= 60_000);
  assert.ok(margin > 35_000 && margin <= 40_000);
});
