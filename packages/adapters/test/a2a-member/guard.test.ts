import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createTargetSource } from '../../src/a2a-member/card.ts';
import { createGuardedFetch, Refused, resolveTarget, type Resolver, type TargetRules } from '../../src/a2a-member/guard.ts';
import { card, startFake, type Fake } from './fake.ts';

const open: Fake[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

async function fake(): Promise<Fake> {
  const f = await startFake();
  open.push(f);
  return f;
}

/** A resolver over a fixed table; it counts the lookups of each name. No network. */
function table(names: Record<string, string[]>) {
  const lookups: Record<string, number> = {};
  const resolve: Resolver = async (hostname) => {
    lookups[hostname] = (lookups[hostname] ?? 0) + 1;
    return (names[hostname] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolve, lookups };
}

const rules = (resolve: Resolver, configured: string[] = [], extra: Partial<TargetRules> = {}): TargetRules => ({ allowHttp: true, configured: new Set(configured), resolve, ...extra });

const PRIVATE = ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.10', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.5', '::ffff:7f00:1'];

test('a host name that resolves to a private, loopback, link-local, unique-local or mapped address is refused', async () => {
  for (const address of PRIVATE) {
    const { resolve } = table({ 'agent.example': [address] });
    const url = new URL('https://agent.example/rpc');
    await assert.rejects(resolveTarget(url, rules(resolve)), Refused, address);
    // configured, but the name does not say it is private: still refused without the opt-in
    await assert.rejects(resolveTarget(url, rules(resolve, [url.origin])), /resolves to a private address/, address);
  }
});

test('one private address among public ones refuses the name; a name without addresses is refused', async () => {
  const { resolve } = table({ 'mixed.example': ['93.184.216.34', '169.254.169.254'], 'public.example': ['93.184.216.34', '2606:2800:220:1::1'] });
  await assert.rejects(resolveTarget(new URL('https://mixed.example/'), rules(resolve)), /resolves to a private address/);
  await assert.rejects(resolveTarget(new URL('https://nowhere.example/'), rules(resolve)), /has no address/);
  assert.deepEqual((await resolveTarget(new URL('https://public.example/'), rules(resolve))).map((a) => a.address), ['93.184.216.34', '2606:2800:220:1::1']);
});

test('private names stay possible for the operator: localhost when configured, any configured name with allowPrivateDns', async () => {
  const { resolve } = table({ localhost: ['127.0.0.1'], 'billing.internal': ['10.0.0.5'] });
  const local = new URL('http://localhost:8080/rpc');
  assert.equal((await resolveTarget(local, rules(resolve, [local.origin])))[0]?.address, '127.0.0.1');
  const internal = new URL('https://billing.internal/rpc');
  assert.equal((await resolveTarget(internal, rules(resolve, [internal.origin], { allowPrivateDns: true })))[0]?.address, '10.0.0.5');
  // the opt-in covers configured origins only
  await assert.rejects(resolveTarget(internal, rules(resolve, [], { allowPrivateDns: true })), /resolves to a private address/);
});

test('the guarded fetch refuses a public-looking name that points at a local server, and nothing reaches the server', async () => {
  const f = await fake();
  const { resolve, lookups } = table({ 'agent.example': ['127.0.0.1'] });
  const port = new URL(f.origin).port;
  const send = createGuardedFetch(rules(resolve));
  await assert.rejects(send(`http://agent.example:${port}/.well-known/agent-card.json`), /resolves to a private address/);
  assert.equal(lookups['agent.example'], 1);
  assert.equal(f.gets['/.well-known/agent-card.json'], undefined);
});

test('the guarded fetch connects to the address that was checked: one resolution per connection, made by the rules', async () => {
  const f = await fake();
  f.card = card(f.origin);
  const { resolve, lookups } = table({ 'agent.internal': ['127.0.0.1'] });
  const origin = `http://agent.internal:${new URL(f.origin).port}`;
  const send = createGuardedFetch(rules(resolve, [origin], { allowPrivateDns: true }));
  const res = await send(`${origin}/.well-known/agent-card.json`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { name: string }).name, 'Billing agent');
  // the name exists only in the table: the request arrived, so the socket used the address the rules returned
  assert.equal(f.gets['/.well-known/agent-card.json'], 1);
  assert.equal(lookups['agent.internal'], 1);
});

test('a resolver that changes its answer cannot move an accepted name inside: every connection is checked', async () => {
  const f = await fake();
  let n = 0;
  const resolve: Resolver = async () => [{ address: n++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
  const url = new URL(`http://rebind.example:${new URL(f.origin).port}/.well-known/agent-card.json`);
  assert.equal((await resolveTarget(url, rules(resolve)))[0]?.address, '93.184.216.34');
  await assert.rejects(createGuardedFetch(rules(resolve))(url), /resolves to a private address/);
  assert.equal(f.gets['/.well-known/agent-card.json'], undefined);
});

test('the member refuses its card URL when the name resolves to a private address, and accepts it with allowPrivateDns', async () => {
  const f = await fake();
  const origin = `http://agent.example:${new URL(f.origin).port}`;
  f.card = card(origin);
  const { resolve } = table({ 'agent.example': ['127.0.0.1'] });
  const options = { url: `${origin}/.well-known/agent-card.json`, allowedEndpoints: [], requireSigned: false, maxCardBytes: 65_536, maxResponseBytes: 65_536, cardTtlMs: 0, fetchTimeoutMs: 2_000 };
  await assert.rejects(createTargetSource(options, rules(resolve, [origin]))(), /resolves to a private address/);
  assert.equal(f.gets['/.well-known/agent-card.json'], undefined);
  const target = await createTargetSource(options, rules(resolve, [origin], { allowPrivateDns: true }))();
  assert.equal(target.endpoint, `${origin}/rpc`);
});

test('the guarded fetch never follows a redirect', async () => {
  const f = await fake();
  const send = createGuardedFetch(rules(table({}).resolve, [f.origin]));
  await assert.rejects(send(`${f.origin}/redirect/agent-card.json`, { redirect: 'follow' }), /redirect refused/);
  assert.equal(f.gets['/.well-known/agent-card.json'], undefined);
});
