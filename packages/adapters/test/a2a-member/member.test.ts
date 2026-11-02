import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import { generateAgentCardSignature } from '@a2a-js/sdk';
import { adapter, BOUNDS_ALIAS_URI, BOUNDS_URI, createA2AMember, limits, type A2AMemberOptions } from '../../src/a2a-member/index.ts';
import { endpointAllowed, isPrivateHost } from '../../src/a2a-member/guard.ts';
import { decodeRef } from '../../src/a2a-member/task.ts';
import { answer, callContext, card, RpcError, sleep, startFake, statusMessage, task, type Fake } from './fake.ts';

// The SDK reports each signature entry that does not verify through console.debug.
mock.method(console, 'debug', () => {});

const open: Fake[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

async function fake(rpc?: Parameters<typeof startFake>[0]): Promise<Fake> {
  const f = await startFake(rpc);
  open.push(f);
  return f;
}

const member = (f: Fake, options: Partial<A2AMemberOptions> = {}) => createA2AMember({ url: f.cardUrl, pollMs: 10, ...options }, { name: 'billing' });

const SECRET = 'tok-secret-credential';

test('descriptor: MemberPort named a2a-member, both tiers, limits declared', () => {
  assert.equal(adapter.fills, 'MemberPort');
  assert.equal(adapter.name, 'a2a-member');
  assert.deepEqual(adapter.tiers, ['prototype', 'production']);
  assert.deepEqual(Object.keys(adapter.limits ?? {}).sort(), ['cancelTimeoutMs', 'cardTtlMs', 'maxCardBytes', 'maxResponseBytes', 'pollMs', 'timeoutMs']);
  assert.equal(limits.timeoutMs.unbounded, 'fail');
  assert.equal(limits.timeoutMs.default, 300_000);
});

test('describe: the entry maps the card; audience comes from the options; the endpoint is the card interface', async () => {
  const f = await fake();
  const entry = await member(f, { audience: 'https://billing.example' }).describe();
  assert.equal(entry.id, 'billing');
  assert.equal(entry.name, 'Billing agent');
  assert.equal(entry.description, 'Answers billing questions');
  assert.equal(entry.version, '1.2.0');
  assert.deepEqual(entry.skills, [{ id: 'invoices', name: 'Invoices', description: 'Looks up invoices', tags: ['billing', 'invoices'] }]);
  assert.deepEqual(entry.endpoint, { protocol: 'a2a', url: f.rpcUrl });
  assert.equal(entry.audience, 'https://billing.example');
  assert.deepEqual(entry.trust, { signed: false, pinned: true });
});

test('describe: the card says nothing about the audience', async () => {
  const f = await fake();
  f.card = card(f.origin, { audience: 'https://evil.example' });
  assert.equal((await member(f).describe()).audience, undefined);
});

test('describe: the card is cached for cardTtlMs, then fetched again', async () => {
  const f = await fake();
  const m = member(f, { cardTtlMs: 150 });
  await m.describe();
  await m.describe();
  assert.equal(f.gets['/.well-known/agent-card.json'], 1);
  await sleep(200);
  await m.describe();
  assert.equal(f.gets['/.well-known/agent-card.json'], 2);
});

test('the card is fetched without credentials or static headers; calls carry them', async () => {
  const f = await fake();
  const m = member(f, { headers: { 'x-api-key': 'k' } });
  await m.describe();
  assert.equal(f.getHeaders.length, 1);
  assert.equal(f.getHeaders[0]!['x-api-key'], undefined);
  assert.equal(f.getHeaders[0]!.authorization, undefined);
  await m.invoke('hi', callContext({ credential: SECRET }));
  assert.equal(f.calls[0]!.headers['x-api-key'], 'k');
  assert.equal(f.calls[0]!.headers.authorization, `Bearer ${SECRET}`);
});

test('url that is a JSON-RPC endpoint: no card is read and the entry is minimal', async () => {
  const f = await fake();
  const entry = await createA2AMember({ url: f.rpcUrl }, { name: 'billing' }).describe();
  assert.equal(entry.name, 'billing');
  assert.deepEqual(entry.endpoint, { protocol: 'a2a', url: f.rpcUrl });
  assert.equal(f.gets['/.well-known/agent-card.json'], undefined);
  const result = await createA2AMember({ url: f.rpcUrl }, { name: 'billing' }).invoke('hi', callContext());
  assert.equal(result.status, 'completed');
});

// Endpoint rules ---------------------------------------------------------------------------------------------------

test('endpoint: a card that points to another origin is refused, in describe and in invoke', async () => {
  const other = await fake();
  const f = await fake();
  f.card = card(f.origin, { supportedInterfaces: [{ url: other.rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
  await assert.rejects(member(f).describe(), /private address that is not configured/);
  const result = await member(f).invoke('hi', callContext({ credential: SECRET }));
  assert.equal(result.status, 'failed');
  assert.equal(result.reason?.code, 'error');
  assert.equal(other.calls.length, 0, 'nothing is sent to the other origin');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('endpoint: allowedEndpoints lets a card point to a configured origin', async () => {
  const other = await fake();
  const f = await fake();
  f.card = card(f.origin, { supportedInterfaces: [{ url: other.rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
  const m = member(f, { allowedEndpoints: [other.origin] });
  assert.deepEqual((await m.describe()).endpoint, { protocol: 'a2a', url: other.rpcUrl });
  assert.equal((await m.invoke('hi', callContext())).status, 'completed');
  assert.equal(other.calls.length, 1);
});

test('endpoint: an endpoint in the options replaces the card interface', async () => {
  const other = await fake();
  const f = await fake();
  f.card = card(f.origin, { supportedInterfaces: [{ url: 'https://elsewhere.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
  const m = member(f, { endpoint: other.rpcUrl });
  assert.deepEqual((await m.describe()).endpoint, { protocol: 'a2a', url: other.rpcUrl });
  assert.equal((await m.invoke('hi', callContext())).status, 'completed');
  assert.equal(other.calls.length, 1);
  assert.equal(f.calls.length, 0);
});

test('https: plain http beyond loopback is refused in the options, in a card and in allowedEndpoints', async () => {
  assert.throws(() => createA2AMember({ url: 'http://agents.example.com/.well-known/agent-card.json' }, { name: 'm' }), /must use https/);
  assert.throws(() => createA2AMember({ url: 'https://a.example/agent-card.json', endpoint: 'http://agents.example.com/rpc' }, { name: 'm' }), /must use https/);
  const f = await fake();
  f.card = card(f.origin, { supportedInterfaces: [{ url: 'http://agents.example.com/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
  await assert.rejects(member(f, { allowedEndpoints: ['https://agents.example.com'] }).describe(), /must use https/);
  // allowHttp accepts it when the origin is listed
  const m = member(f, { allowHttp: true, allowedEndpoints: ['http://agents.example.com'] });
  assert.deepEqual((await m.describe()).endpoint, { protocol: 'a2a', url: 'http://agents.example.com/rpc' });
});

test('private addresses: IPv4-mapped IPv6 in hex form follows the IPv4 rule', async () => {
  const f = await fake();
  for (const url of ['https://[::ffff:7f00:1]/rpc', 'https://[::ffff:a00:1]/rpc', 'https://[::ffff:c0a8:101]/rpc', 'https://[::ffff:a9fe:a9fe]/rpc']) {
    f.card = card(f.origin, { supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
    await assert.rejects(member(f).describe(), /private address that is not configured/, url);
  }
  assert.equal(isPrivateHost('[::ffff:808:808]'), false, 'a public mapped address');
  assert.equal(isPrivateHost('[::ffff:7f00:1]'), true);
});

test('endpoint: an allowedEndpoints path prefix matches on a / boundary', () => {
  const card = new URL('https://card.example/.well-known/agent-card.json');
  const allowed = ['https://a.com/api'];
  assert.equal(endpointAllowed(new URL('https://a.com/api'), card, allowed), true);
  assert.equal(endpointAllowed(new URL('https://a.com/api/rpc'), card, allowed), true);
  assert.equal(endpointAllowed(new URL('https://a.com/api-x'), card, allowed), false);
  assert.equal(endpointAllowed(new URL('https://a.com/apix/rpc'), card, allowed), false);
  assert.equal(endpointAllowed(new URL('https://a.com/other'), card, allowed), false);
});

test('private addresses: refused unless the operator configured that origin', async () => {
  const f = await fake();
  for (const url of ['https://10.0.0.5/rpc', 'https://192.168.1.10/rpc', 'https://169.254.169.254/rpc', 'https://[::1]/rpc', 'https://localhost/rpc']) {
    f.card = card(f.origin, { supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
    await assert.rejects(member(f).describe(), /private address that is not configured/, url);
  }
  // listed by the operator, the same private origin is accepted
  f.card = card(f.origin, { supportedInterfaces: [{ url: 'https://10.0.0.5/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
  assert.equal((await member(f, { allowedEndpoints: ['https://10.0.0.5'] }).describe()).endpoint.url, 'https://10.0.0.5/rpc');
});

test('credentials in the endpoint URL are refused', async () => {
  const f = await fake();
  f.card = card(f.origin, { supportedInterfaces: [{ url: `${f.origin.replace('//', '//user:pw@')}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
  await assert.rejects(member(f).describe(), /must not carry credentials/);
});

test('redirects are refused for the card and for calls', async () => {
  const f = await fake();
  await assert.rejects(createA2AMember({ url: `${f.origin}/redirect/agent-card.json` }, { name: 'm' }).describe());
  assert.equal(f.gets['/.well-known/agent-card.json'], undefined, 'the redirect is not followed');
  const result = await createA2AMember({ url: `${f.origin}/redirect-rpc` }, { name: 'm' }).invoke('hi', callContext({ credential: SECRET }));
  assert.deepEqual([result.status, result.reason?.detail], ['failed', 'remote agent call failed']);
  assert.equal(f.calls.length, 0, 'the credential is not sent to the redirect target');
});

test('card size: a card above maxCardBytes is refused', async () => {
  const f = await fake();
  f.card = card(f.origin, { description: 'x'.repeat(5000) });
  await assert.rejects(member(f, { maxCardBytes: 1024 }).describe(), /size limit/);
  assert.equal((await member(f, { maxCardBytes: 65_536 }).describe()).description.length, 5000);
});

// Signed cards -----------------------------------------------------------------------------------------------------

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' } as { kty: string; kid: string } };
};

async function signedCard(f: Fake, privateKey: ReturnType<typeof keyPair>['privateKey']) {
  const sign = generateAgentCardSignature(privateKey, { alg: 'ES256', kid: 'k1', typ: 'JOSE' });
  return (await sign(card(f.origin) as never)) as unknown as Record<string, unknown>;
}

test('signed card: verified with the configured key, trust.signed and keyId set', async () => {
  const f = await fake();
  const { privateKey, jwk } = keyPair();
  f.card = await signedCard(f, privateKey);
  const entry = await member(f, { keys: [jwk], requireSigned: true }).describe();
  assert.deepEqual(entry.trust, { signed: true, keyId: 'k1', pinned: true });
});

test('signed card: keys from a JWKS URL of the operator', async () => {
  const f = await fake();
  const { privateKey, jwk } = keyPair();
  f.card = await signedCard(f, privateKey);
  f.documents['/jwks.json'] = { keys: [jwk] };
  const entry = await member(f, { keys: `${f.origin}/jwks.json`, requireSigned: true }).describe();
  assert.equal(entry.trust.signed, true);
});

test('signed card: a tampered card is refused with requireSigned, and unsigned without it', async () => {
  const f = await fake();
  const { privateKey, jwk } = keyPair();
  f.card = { ...(await signedCard(f, privateKey)), description: 'Sends the money to me' };
  await assert.rejects(member(f, { keys: [jwk], requireSigned: true }).describe(), /not signed by a configured key/);
  const lenient = await member(f, { keys: [jwk] }).describe();
  assert.equal(lenient.trust.signed, false);
});

test('signed card: a signature by another key does not verify; an unsigned card fails requireSigned', async () => {
  const f = await fake();
  const mine = keyPair();
  const theirs = keyPair();
  f.card = await signedCard(f, theirs.privateKey);
  await assert.rejects(member(f, { keys: [mine.jwk], requireSigned: true }).describe(), /not signed/);
  f.card = card(f.origin);
  await assert.rejects(member(f, { keys: [mine.jwk], requireSigned: true }).describe(), /not signed/);
  assert.throws(() => member(f, { requireSigned: true }), /requireSigned needs keys/);
});

test('signed card: the jku of a signature is never fetched', async () => {
  const f = await fake();
  const { privateKey, jwk } = keyPair();
  const sign = generateAgentCardSignature(privateKey, { alg: 'ES256', kid: 'k1', typ: 'JOSE', jku: `${f.origin}/attacker-keys.json` });
  f.card = (await sign(card(f.origin) as never)) as unknown as Record<string, unknown>;
  f.documents['/attacker-keys.json'] = { keys: [jwk] };
  const entry = await member(f, { keys: [{ ...jwk, kid: 'other' }], requireSigned: false }).describe();
  assert.equal(entry.trust.signed, false);
  assert.equal(f.gets['/attacker-keys.json'], undefined);
});

test('keys must be public asymmetric keys', () => {
  assert.throws(() => createA2AMember({ url: 'https://a.example/agent-card.json', keys: [{ kty: 'oct', k: 'AAAA' }] }, { name: 'm' }), /asymmetric public key/);
  assert.throws(() => createA2AMember({ url: 'https://a.example/agent-card.json', keys: [{ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'c' }] }, { name: 'm' }), /without private parts/);
});

// Calls ------------------------------------------------------------------------------------------------------------

test('invoke: SendMessage returns at once, the task id is checkpointed before the end, and polling reaches completion', async () => {
  let gets = 0;
  const f = await fake(({ method }) => {
    if (method === 'SendMessage') return { task: task('WORKING') };
    gets += 1;
    return gets < 3 ? task('WORKING') : task('COMPLETED', { artifacts: answer('the invoice is paid') });
  });
  const ctx = callContext();
  const seenAtCheckpoint: string[][] = [];
  ctx.checkpoint = async (ref) => {
    ctx.checkpoints.push(ref);
    seenAtCheckpoint.push(f.methods());
  };
  const result = await member(f).invoke('status of invoice 7?', ctx);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'the invoice is paid');
  assert.equal(ctx.checkpoints.length, 1);
  assert.deepEqual(decodeRef(ctx.checkpoints[0]!), { taskId: 'task-1', contextId: 'ctx-1' });
  assert.deepEqual(seenAtCheckpoint[0], ['SendMessage'], 'checkpointed before any poll');
  assert.deepEqual(f.methods(), ['SendMessage', 'GetTask', 'GetTask', 'GetTask']);
  const send = f.calls[0]!.params;
  assert.equal(send.configuration.returnImmediately, true);
  assert.equal(send.message.parts[0].text, 'status of invoice 7?');
  assert.equal(f.calls[1]!.params.id, 'task-1');
});

test('invoke: a task already completed in the reply is not checkpointed; a direct message reply completes', async () => {
  const f = await fake();
  const ctx = callContext();
  const done = await member(f).invoke('hi', ctx);
  assert.equal(done.status, 'completed');
  assert.equal(ctx.checkpoints.length, 0);
  f.rpc = () => ({ message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'direct reply' }] } });
  const reply = await member(f).invoke('hi', callContext());
  assert.deepEqual([reply.status, reply.output], ['completed', 'direct reply']);
});

test('invoke: the output is the artifacts text, else the status message', async () => {
  const f = await fake(() => ({ task: task('COMPLETED', { status: { state: 'TASK_STATE_COMPLETED', message: statusMessage('from status') } }) }));
  assert.equal((await member(f).invoke('x', callContext())).output, 'from status');
  f.rpc = () => ({ task: task('COMPLETED', { artifacts: [{ artifactId: 'a', parts: [{ text: 'one' }] }, { artifactId: 'b', parts: [{ text: 'two' }] }] }) });
  assert.equal((await member(f).invoke('x', callContext())).output, 'one\ntwo');
});

test('state mapping: canceled, rejected, failed, auth-required, input-required and unknown states', async () => {
  const f = await fake();
  const run = async (state: string, extra: Record<string, unknown> = {}) => {
    f.rpc = () => ({ task: task(state, extra) });
    return member(f).invoke('x', callContext());
  };
  const canceled = await run('CANCELED');
  assert.deepEqual([canceled.status, canceled.reason?.code, canceled.reason?.layer], ['stopped', 'aborted', undefined]);
  const rejected = await run('REJECTED');
  assert.deepEqual([rejected.status, rejected.reason?.code, rejected.reason?.layer], ['stopped', 'rejected', undefined]);
  const failed = await run('FAILED', { status: { state: 'TASK_STATE_FAILED', message: statusMessage('remote wording') } });
  assert.deepEqual([failed.status, failed.reason?.code, failed.output], ['failed', 'error', '']);
  const auth = await run('AUTH_REQUIRED');
  assert.deepEqual([auth.status, auth.reason?.code], ['waiting', 'needs_auth']);
  assert.ok(auth.taskRef);
  const input = await run('INPUT_REQUIRED', { status: { state: 'TASK_STATE_INPUT_REQUIRED', message: statusMessage('Which account?') } });
  assert.deepEqual([input.status, input.reason?.code, input.output], ['waiting', 'needs_input', 'Which account?']);
  assert.deepEqual(decodeRef(input.taskRef!), { taskId: 'task-1', contextId: 'ctx-1' });
  const unknown = await run('PAUSED_BY_VENDOR');
  assert.deepEqual([unknown.status, unknown.reason?.code], ['failed', 'error']);
  assert.equal(typeof unknown.ext?.['a2a-member.state'], 'string');
});

test('input-required: waiting with taskRef; resume with input sends it on the same task and context, then polls', async () => {
  let phase = 0;
  const f = await fake(({ method }) => {
    if (method === 'SendMessage' && phase === 0) {
      phase = 1;
      return { task: task('INPUT_REQUIRED', { status: { state: 'TASK_STATE_INPUT_REQUIRED', message: statusMessage('Which account?') } }) };
    }
    if (method === 'SendMessage') return { task: task('WORKING') };
    return task('COMPLETED', { artifacts: answer('account 42 settled') });
  });
  const m = member(f);
  const waiting = await m.invoke('settle my invoice', callContext());
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.output, 'Which account?');
  const resumed = await m.resume!(waiting.taskRef!, 'account 42', callContext());
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.output, 'account 42 settled');
  const reply = f.calls[1]!.params.message;
  assert.equal(reply.taskId, 'task-1');
  assert.equal(reply.contextId, 'ctx-1');
  assert.equal(reply.parts[0].text, 'account 42');
  assert.deepEqual(f.methods(), ['SendMessage', 'SendMessage', 'GetTask']);
});

test('resume without input: continues polling that task and does not send a message', async () => {
  let gets = 0;
  const f = await fake(() => {
    gets += 1;
    return gets < 2 ? task('WORKING', { id: 'task-9' }) : task('COMPLETED', { id: 'task-9', artifacts: answer('late answer') });
  });
  const ctx = callContext();
  const ref = (await import('../../src/a2a-member/task.ts')).encodeRef('task-9', 'ctx-9');
  const result = await member(f).resume!(ref, undefined, ctx);
  assert.deepEqual([result.status, result.output], ['completed', 'late answer']);
  assert.deepEqual(f.methods(), ['GetTask', 'GetTask']);
  assert.equal(f.calls[0]!.params.id, 'task-9');
  assert.equal(ctx.checkpoints.length, 0, 'the reference is already journaled');
});

test('resume with a reference that is not this member\'s fails without a call', async () => {
  const f = await fake();
  const result = await member(f).resume!('not-a-ref', undefined, callContext());
  assert.equal(result.status, 'failed');
  assert.equal(f.calls.length, 0);
});

test('abort after the checkpoint: stopped/aborted, the cancel is left to the core', async () => {
  const f = await fake(({ method }) => (method === 'CancelTask' ? task('CANCELED') : method === 'SendMessage' ? { task: task('WORKING') } : task('WORKING')));
  const controller = new AbortController();
  const ctx = callContext({ signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  const result = await member(f).invoke('long job', ctx);
  assert.deepEqual([result.status, result.reason?.code], ['stopped', 'aborted']);
  assert.equal(ctx.checkpoints.length, 1);
  assert.equal(f.methods().includes('CancelTask'), false);
});

test('abort on a resumed task: the core has the reference, so no CancelTask is sent', async () => {
  const f = await fake(({ method }) => (method === 'CancelTask' ? task('CANCELED') : task('WORKING')));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  const ref = (await import('../../src/a2a-member/task.ts')).encodeRef('task-1', 'ctx-1');
  const result = await member(f).resume!(ref, undefined, callContext({ signal: controller.signal }));
  assert.deepEqual([result.status, result.reason?.code], ['stopped', 'aborted']);
  assert.equal(f.methods().includes('CancelTask'), false);
});

test('the core\'s own timeout after the checkpoint: stopped/timeout, the cancel is left to the core', async () => {
  const f = await fake(({ method }) => (method === 'CancelTask' ? task('CANCELED') : method === 'SendMessage' ? { task: task('WORKING') } : task('WORKING')));
  const controller = new AbortController();
  const ctx = callContext({ signal: controller.signal });
  setTimeout(() => controller.abort(new DOMException('the call ran out of time', 'TimeoutError')), 80);
  const result = await member(f).invoke('long job', ctx);
  assert.deepEqual([result.status, result.reason?.code], ['stopped', 'timeout']);
  assert.equal(ctx.checkpoints.length, 1);
  assert.equal(f.methods().includes('CancelTask'), false);
});

test('abort before the checkpoint is kept: CancelTask is sent for the task the core does not know', async () => {
  const f = await fake(({ method }) => (method === 'CancelTask' ? task('CANCELED') : method === 'SendMessage' ? { task: task('WORKING') } : task('WORKING')));
  const controller = new AbortController();
  const ctx = callContext({ signal: controller.signal });
  ctx.checkpoint = async () => {
    controller.abort();
    throw new Error('aborted while journaling');
  };
  const result = await member(f).invoke('long job', ctx);
  assert.deepEqual([result.status, result.reason?.code], ['stopped', 'aborted']);
  assert.equal(f.calls.find((c) => c.method === 'CancelTask')!.params.id, 'task-1');
});

test('failure after the task id is known: the remote task is cancelled (checkpoint rejects, GetTask errors)', async () => {
  const f = await fake(({ method }) => {
    if (method === 'SendMessage') return { task: task('WORKING') };
    if (method === 'CancelTask') return task('CANCELED');
    throw new RpcError(-32603);
  });
  const ctx = callContext();
  ctx.checkpoint = async () => {
    throw new Error('journal down');
  };
  const rejected = await member(f).invoke('x', ctx);
  assert.deepEqual([rejected.status, rejected.reason?.detail], ['failed', 'remote agent call failed']);
  assert.deepEqual(f.methods(), ['SendMessage', 'CancelTask']);
  assert.equal(f.calls[1]!.params.id, 'task-1');
  f.calls.length = 0;
  const polled = await member(f).invoke('x', callContext());
  assert.equal(polled.status, 'failed');
  assert.deepEqual(f.methods(), ['SendMessage', 'GetTask', 'CancelTask']);
  assert.equal(f.calls[2]!.params.id, 'task-1');
});

test('resume with input: a different task id from the agent is checkpointed', async () => {
  let n = 0;
  const f = await fake(({ method }) => {
    if (method === 'SendMessage') return { task: task('WORKING', { id: 'task-2', contextId: 'ctx-2' }) };
    n += 1;
    return task('COMPLETED', { id: 'task-2', contextId: 'ctx-2', artifacts: answer('ok') });
  });
  const ctx = callContext();
  const ref = (await import('../../src/a2a-member/task.ts')).encodeRef('task-1', 'ctx-1');
  const result = await member(f).resume!(ref, 'more', ctx);
  assert.equal(result.status, 'completed');
  assert.equal(ctx.checkpoints.length, 1);
  assert.deepEqual(decodeRef(ctx.checkpoints[0]!), { taskId: 'task-2', contextId: 'ctx-2' });
  assert.equal(n, 1);
  // the same id is not journaled again
  const same = callContext();
  f.rpc = ({ method }) => (method === 'SendMessage' ? { task: task('WORKING') } : task('COMPLETED', { artifacts: answer('ok') }));
  await member(f).resume!(ref, 'more', same);
  assert.equal(same.checkpoints.length, 0);
});

test('response size: an answer above maxResponseBytes fails with a fixed detail', async () => {
  const f = await fake(() => ({ task: task('COMPLETED', { artifacts: answer('x'.repeat(5000)) }) }));
  const small = await member(f, { maxResponseBytes: 1024 }).invoke('x', callContext());
  assert.deepEqual([small.status, small.reason?.code, small.reason?.layer], ['failed', 'error', 'member']);
  assert.equal(small.reason?.detail, 'remote agent answer is larger than the size limit');
  assert.equal(JSON.stringify(small).includes('xxxx'), false);
  const big = await member(f, { maxResponseBytes: 65_536 }).invoke('x', callContext());
  assert.equal(big.status, 'completed');
  assert.equal(big.output.length, 5000);
});

test('abort before the call: nothing is sent', async () => {
  const f = await fake();
  const controller = new AbortController();
  controller.abort();
  const result = await member(f).invoke('x', callContext({ signal: controller.signal }));
  assert.deepEqual([result.status, result.reason?.code], ['stopped', 'aborted']);
  assert.equal(f.calls.length, 0);
});

test('deadline: the time left of the run ends the call as stopped/timeout and cancels the task', async () => {
  const f = await fake(({ method }) => (method === 'SendMessage' ? { task: task('WORKING') } : task(method === 'CancelTask' ? 'CANCELED' : 'WORKING')));
  const started = Date.now();
  const result = await member(f).invoke('long job', callContext({ remainingMs: 250 }));
  assert.deepEqual([result.status, result.reason?.code], ['stopped', 'timeout']);
  assert.ok(Date.now() - started < 2000);
  assert.ok(f.methods().includes('CancelTask'));
});

test('deadline: options.timeoutMs bounds the call when it is the smaller one', async () => {
  const f = await fake(({ method }) => (method === 'SendMessage' ? { task: task('WORKING') } : task(method === 'CancelTask' ? 'CANCELED' : 'WORKING')));
  const result = await member(f, { timeoutMs: 200 }).invoke('long job', callContext({ remainingMs: 60_000 }));
  assert.deepEqual([result.status, result.reason?.code], ['stopped', 'timeout']);
});

test('A2A 0.3 agents: the card and the lower-case wire are read through the SDK compatibility layer', async () => {
  let polls = 0;
  const f = await fake(({ method }) => {
    if (method === 'message/send') return { kind: 'task', id: 'old-1', contextId: 'old-ctx', status: { state: 'working' } };
    polls += 1;
    return { kind: 'task', id: 'old-1', contextId: 'old-ctx', status: { state: 'completed' }, artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text: 'legacy answer' }] }] };
  });
  f.card = {
    protocolVersion: '0.3.0', name: 'Old agent', description: 'Speaks 0.3', version: '0.9', url: f.rpcUrl, preferredTransport: 'JSONRPC',
    capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 's', name: 'S', description: 'd', tags: ['t'] }],
  };
  const m = member(f);
  assert.equal((await m.describe()).name, 'Old agent');
  const result = await m.invoke('hello', callContext());
  assert.deepEqual([result.status, result.output], ['completed', 'legacy answer']);
  assert.equal(polls, 1);
  assert.deepEqual(f.methods(), ['message/send', 'tasks/get']);
  assert.equal(f.calls[0]!.headers['x-a2a-extensions'], BOUNDS_URI);
});

test('cancel: sends CancelTask for the task of the reference', async () => {
  const f = await fake(() => task('CANCELED'));
  const ref = (await import('../../src/a2a-member/task.ts')).encodeRef('task-5', 'ctx-5');
  await member(f).cancel!(ref, callContext());
  assert.deepEqual(f.methods(), ['CancelTask']);
  assert.equal(f.calls[0]!.params.id, 'task-5');
});

test('cancel: a remote error is a fixed error', async () => {
  const f = await fake(() => {
    throw new RpcError(-32002, `secret ${SECRET}`);
  });
  const ref = (await import('../../src/a2a-member/task.ts')).encodeRef('task-5', 'ctx-5');
  await assert.rejects(member(f).cancel!(ref, callContext({ credential: SECRET })), (e: Error) => e.message === 'a2a-member: cancel failed');
});

// Bounds, credentials, figures -------------------------------------------------------------------------------------

test('bounds: the extension is activated by header and carried in message metadata under its URI, not required', async () => {
  const f = await fake();
  const ctx = callContext({
    remainingMs: 45_000,
    outbound: { remainingMs: 45_000, hops: 2, maxHops: 4, tokens: 1000, costUsd: 0.5, rootRunId: 'root-9', parentRunId: 'run-7' },
  });
  await member(f).invoke('hi', ctx);
  const call = f.calls[0]!;
  assert.equal(call.headers['a2a-extensions'], BOUNDS_URI);
  const data = call.params.message.metadata[BOUNDS_URI];
  assert.ok(data.remainingMs <= 45_000 && data.remainingMs > 44_000, 'time left, tightened by the time already spent');
  assert.deepEqual({ ...data, remainingMs: 0 }, { remainingMs: 0, hops: 2, maxHops: 4, tokens: 1000, costUsd: 0.5, rootRunId: 'root-9', parentRunId: 'run-7' });
  assert.deepEqual(call.params.message.extensions, [BOUNDS_URI]);
  assert.equal(BOUNDS_URI, 'https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md');
});

test('bounds: boundsUri "plexus" sends the alias URI instead, for older peers', async () => {
  const f = await fake();
  await member(f, { boundsUri: 'plexus' }).invoke('hi', callContext());
  const call = f.calls[0]!;
  assert.equal(call.headers['a2a-extensions'], BOUNDS_ALIAS_URI);
  assert.deepEqual(call.params.message.extensions, [BOUNDS_ALIAS_URI]);
  assert.ok(call.params.message.metadata[BOUNDS_ALIAS_URI]);
  assert.equal(BOUNDS_URI in call.params.message.metadata, false);
  assert.throws(() => member(f, { boundsUri: 'other' as never }), /boundsUri must be one of canonical, plexus/);
});

test('bounds report: figures under either URI settle the call; a reported stop maps to its code', async () => {
  const f = await fake(() => ({ task: task('COMPLETED', { artifacts: answer('ok'), metadata: { [BOUNDS_URI]: { usage: { inputTokens: 7, outputTokens: 3 }, costUsd: 0.1 }, 'agent-layers': { usage: { inputTokens: 99, outputTokens: 99 } } } }) }));
  const ok = await member(f).invoke('x', callContext());
  assert.deepEqual([ok.usage, ok.costUsd], [{ inputTokens: 7, outputTokens: 3 }, 0.1]);
  for (const [state, stop] of [['REJECTED', 'hop_limit'], ['FAILED', 'timeout'], ['CANCELED', 'limit']] as const) {
    f.rpc = () => ({ task: task(state, { metadata: { [BOUNDS_ALIAS_URI]: { stop, costUsd: 0.2 }, 'agent-layers': { usage: { inputTokens: 1, outputTokens: 2 } } } }) });
    const r = await member(f).invoke('x', callContext());
    assert.deepEqual([r.status, r.reason?.code, r.reason?.by, r.costUsd, r.usage], ['stopped', stop, 'billing', 0.2, { inputTokens: 1, outputTokens: 2 }]);
  }
  // A stop the extension does not define, or one outside the report, is not read.
  f.rpc = () => ({ task: task('REJECTED', { metadata: { [BOUNDS_URI]: { stop: 'boom' }, 'agent-layers': { stop: 'hop_limit' } } }) });
  assert.equal((await member(f).invoke('x', callContext())).reason?.code, 'rejected');
});

test('bounds: optional budget fields are left out when absent; the effective time is the smaller of timeoutMs and the time left', async () => {
  const f = await fake();
  await member(f, { timeoutMs: 5000 }).invoke('hi', callContext({ remainingMs: 60_000 }));
  const data = f.calls[0]!.params.message.metadata[BOUNDS_URI];
  assert.ok(data.remainingMs <= 5000);
  assert.equal('tokens' in data, false);
  assert.equal('costUsd' in data, false);
});

test('credential: sent as Bearer on every call, replaces a static authorization, and never appears in results or errors', async () => {
  const f = await fake(({ method }) => (method === 'SendMessage' ? { task: task('WORKING') } : task('COMPLETED', { artifacts: answer('ok') })));
  const result = await member(f, { headers: { Authorization: 'Bearer static', 'x-team': 'desk' } }).invoke('hi', callContext({ credential: SECRET }));
  assert.equal(result.status, 'completed');
  for (const call of f.calls) {
    assert.equal(call.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(call.headers['x-team'], 'desk');
  }
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  // no credential: the static header stays
  await member(f, { headers: { Authorization: 'Bearer static' } }).invoke('hi', callContext());
  assert.equal(f.calls.at(-1)!.headers.authorization, 'Bearer static');
});

test('transport errors: a failed result with a fixed detail; error bodies are not read or returned', async () => {
  const f = await fake();
  f.failWith = { status: 500, body: `upstream echoed Authorization: Bearer ${SECRET}` };
  const result = await member(f).invoke('hi', callContext({ credential: SECRET }));
  assert.deepEqual([result.status, result.reason?.code, result.reason?.layer], ['failed', 'error', 'member']);
  assert.equal(result.reason?.detail, 'remote agent call failed');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes('echoed'), false);
  // a JSON-RPC error from the remote side is the same
  f.failWith = undefined;
  f.rpc = () => {
    throw new RpcError(-32001, `task not found ${SECRET}`);
  };
  const rpcError = await member(f).invoke('hi', callContext({ credential: SECRET }));
  assert.equal(rpcError.reason?.detail, 'remote agent call failed');
  assert.equal(JSON.stringify(rpcError).includes(SECRET), false);
});

test('usage and cost: read from metadata["agent-layers"]; malformed values are ignored', async () => {
  const f = await fake(() => ({ task: task('COMPLETED', { artifacts: answer('ok'), metadata: { 'agent-layers': { usage: { inputTokens: 12, outputTokens: 5 }, costUsd: 0.25 } } }) }));
  const ok = await member(f).invoke('x', callContext());
  assert.deepEqual(ok.usage, { inputTokens: 12, outputTokens: 5 });
  assert.equal(ok.costUsd, 0.25);
  f.rpc = () => ({ task: task('COMPLETED', { artifacts: answer('ok'), metadata: { 'agent-layers': { usage: { inputTokens: 'many', outputTokens: 5 }, costUsd: -3 } } }) });
  const bad = await member(f).invoke('x', callContext());
  assert.equal(bad.usage, undefined);
  assert.equal(bad.costUsd, undefined);
  f.rpc = () => ({ task: task('COMPLETED', { artifacts: answer('ok') }) });
  const none = await member(f).invoke('x', callContext());
  assert.equal('usage' in none, false);
});

test('options: limits are validated', () => {
  const url = 'https://a.example/agent-card.json';
  assert.throws(() => createA2AMember({ url, pollMs: 1 }, { name: 'm' }), /pollMs/);
  assert.throws(() => createA2AMember({ url, maxCardBytes: 10 }, { name: 'm' }), /maxCardBytes/);
  assert.throws(() => createA2AMember({ url, maxResponseBytes: 10 }, { name: 'm' }), /maxResponseBytes/);
  assert.throws(() => createA2AMember({ url, timeoutMs: 0 }, { name: 'm' }), /timeoutMs/);
  assert.doesNotThrow(() => createA2AMember({ url, timeoutMs: 'unbounded' }, { name: 'm' }));
  assert.throws(() => createA2AMember({} as never, { name: 'm' }), /url is required/);
});
