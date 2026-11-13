import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createTargetSource } from '../../src/a2a-member/card.ts';
import { createGuardedFetch, isPrivateHost, isSpecialAddress, Refused, resolveTarget, type Resolver, type TargetRules } from '../../src/a2a-member/guard.ts';
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

/** One address of every range that is not public unicast, by the name of the range. */
const SPECIAL: Record<string, string> = {
  'this network 0/8': '0.1.2.3',
  'private 10/8': '10.255.0.1',
  'shared 100.64/10': '100.127.255.254',
  'loopback 127/8': '127.8.8.8',
  'link-local 169.254/16': '169.254.169.254',
  'private 172.16/12': '172.31.255.1',
  'protocol assignments 192.0.0/24': '192.0.0.192',
  'documentation 192.0.2/24': '192.0.2.1',
  '6to4 relay 192.88.99/24': '192.88.99.1',
  'private 192.168/16': '192.168.0.1',
  'benchmarking 198.18/15': '198.19.0.1',
  'documentation 198.51.100/24': '198.51.100.7',
  'documentation 203.0.113/24': '203.0.113.7',
  'multicast 224/4': '239.255.255.250',
  'reserved 240/4': '240.0.0.1',
  'broadcast': '255.255.255.255',
  'unspecified ::': '::',
  'loopback ::1': '::1',
  'mapped ::ffff:0:0/96, dotted': '::ffff:192.168.1.10',
  'mapped ::ffff:0:0/96, hex': '::ffff:a9fe:a9fe',
  'compatible ::/96': '::10.0.0.5',
  'NAT64 64:ff9b::/96 of a private address': '64:ff9b::a00:5',
  'NAT64 64:ff9b::/96 of the metadata address, dotted': '64:ff9b::169.254.169.254',
  'NAT64 local-use 64:ff9b:1::/48': '64:ff9b:1::808:808',
  'discard 100::/64': '100::1',
  'Teredo 2001::/32': '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  'documentation 2001:db8::/32': '2001:db8::1',
  '6to4 2002::/16 of a private address': '2002:c0a8:101::1',
  '6to4 2002::/16 of loopback': '2002:7f00:1::',
  'unique-local fc00::/7': 'fd12:3456:789a::1',
  'link-local fe80::/10': 'fe80::1%eth0',
  'multicast ff00::/8': 'ff02::1',
  'outside global unicast': '4000::1',
};

test('every special-purpose range is refused when a host name resolves into it, alone or next to a public address', async () => {
  for (const [range, address] of Object.entries(SPECIAL)) {
    assert.equal(isSpecialAddress(address), true, range);
    for (const answer of [[address], ['93.184.216.34', address]]) {
      const { resolve } = table({ 'agent.example': answer });
      await assert.rejects(resolveTarget(new URL('https://agent.example/rpc'), rules(resolve)), /resolves to a private address/, range);
    }
  }
});

test('public unicast addresses pass, also inside a mapped, NAT64 or 6to4 wrapper', async () => {
  const publics = ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1'];
  const { resolve } = table({ 'agent.example': publics });
  assert.equal((await resolveTarget(new URL('https://agent.example/rpc'), rules(resolve))).length, publics.length);
  for (const address of publics) assert.equal(isSpecialAddress(address), false, address);
});

test('an address the resolver gives that is not an IP address is refused; a host name written in a URL is not judged as one', async () => {
  const { resolve } = table({ 'agent.example': ['not-an-address'] });
  await assert.rejects(resolveTarget(new URL('https://agent.example/rpc'), rules(resolve)), /resolves to a private address/);
  assert.equal(isPrivateHost('agent.example'), false);
  assert.equal(isPrivateHost('[64:ff9b::a00:5]'), true);
  assert.equal(isPrivateHost('[2002:c0a8:101::1]'), true);
  assert.equal(isPrivateHost('[2606:2800:220:1::1]'), false);
});
