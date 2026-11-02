import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assemble, defineAdapter, inputText, PORT_VERSIONS, prototypeHost, resolveConfig, type AdapterDescriptor, type MemberPort, type TopologyPort,
} from '@agent-plexus/core';
import { adapter, createMemoryExecution, limits } from '../src/index.ts';

const make = (maxRuns?: number) => createMemoryExecution(maxRuns === undefined ? {} : { maxRuns }, { name: 'execution' });
const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

test('adapter descriptor and limit', () => {
  assert.equal(adapter.fills, 'ExecutionPort');
  assert.deepEqual(adapter.tiers, ['prototype']);
  assert.equal(limits.maxRuns.default, 1000);
  assert.equal(adapter.limits, limits);
});

test('step runs once; the same runKey resumes and replays stored results', async () => {
  const port = make();
  let calls = 0;
  const first = await port.begin('run-1');
  assert.equal(first.runKey, 'run-1');
  assert.deepEqual(await first.step('a', async () => ({ n: ++calls })), { n: 1 });
  const resumed = await port.begin('run-1');
  assert.deepEqual(await resumed.step('a', async () => ({ n: ++calls })), { n: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(await resumed.step('b', async () => ({ n: ++calls })), { n: 2 });
});

test('results are cloned on store and on read', async () => {
  const port = make();
  const run = await port.begin('r');
  const source = { list: [1] };
  const first = await run.step('s', async () => source);
  source.list.push(2);
  first.list.push(3);
  assert.deepEqual(await run.step('s', async () => ({ list: [] })), { list: [1] });
});

test('a step that returns undefined replays as undefined; a step that throws is not stored', async () => {
  const run = await make().begin('r');
  let calls = 0;
  assert.equal(await run.step('u', async () => { calls++; return undefined; }), undefined);
  assert.equal(await run.step('u', async () => { calls++; return 1; }), undefined);
  assert.equal(calls, 1);
  await assert.rejects(run.step('t', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await run.step('t', async () => 'ok'), 'ok');
});

test('a value that is not JSON fails the step', async () => {
  const run = await make().begin('r');
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  await assert.rejects(run.step('c', async () => loop), TypeError);
});

test('concurrent calls of one step share a single run of the function', async () => {
  const run = await make().begin('r');
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return 'v'; };
  assert.deepEqual(await Promise.all([run.step('s', fn), run.step('s', fn)]), ['v', 'v']);
  assert.equal(calls, 1);
});

test('different runs do not share steps; prototype-key names and keys work', async () => {
  const port = make();
  const a = await port.begin('constructor');
  const b = await port.begin('__proto__');
  assert.equal(await a.step('toString', async () => 1), 1);
  assert.equal(await b.step('toString', async () => 2), 2);
  assert.equal(await (await port.begin('constructor')).step('toString', async () => 3), 1);
});

test('wait resolves with the value given by signal', async () => {
  const port = make();
  const run = await port.begin('r');
  const waiting = run.wait('approval', soon(5000));
  assert.equal(await port.signal('r', 'approval', { ok: true }), true);
  assert.deepEqual(await waiting, { ok: true });
  assert.deepEqual(await run.wait('approval', soon(5000)), { ok: true });
});

test('a signal that arrives before the wait is delivered to it', async () => {
  const port = make();
  const run = await port.begin('r');
  await port.signal('r', 'early', 'yes');
  assert.equal(await run.wait('early', soon(5000)), 'yes');
});

test('wait gives undefined at the deadline, and a late signal is ignored', async () => {
  const port = make();
  const run = await port.begin('r');
  const started = Date.now();
  assert.equal(await run.wait('slow', soon(20)), undefined);
  assert.ok(Date.now() - started >= 15);
  assert.equal(await port.signal('r', 'slow', 'late'), false);
  assert.equal(await run.wait('slow', soon(5000)), undefined);
  assert.equal(await run.wait('past', new Date(Date.now() - 1000).toISOString()), undefined);
});

test('one signal releases every waiter of the name', async () => {
  const port = make();
  const run = await port.begin('r');
  const both = Promise.all([run.wait('n', soon(5000)), run.wait('n', soon(5000))]);
  await port.signal('r', 'n', 7);
  assert.deepEqual(await both, [7, 7]);
});

test('wait with an invalid date rejects; signal for an unknown run rejects', async () => {
  const port = make();
  const run = await port.begin('r');
  await assert.rejects(run.wait('x', 'not a date'), TypeError);
  await assert.rejects(port.signal('nope', 'x', 1), /unknown run/);
});

test('the wait timer does not keep the process alive', async () => {
  const code = `
    import { createMemoryExecution } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
    const run = await createMemoryExecution({}, { name: 'e' }).begin('r');
    await run.wait('w', new Date(Date.now() + 60000).toISOString());
    console.log('unreachable');
  `;
  const { spawnSync } = await import('node:child_process');
  const started = Date.now();
  const out = spawnSync(process.execPath, ['--conditions=@agent-plexus/source', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000 });
  assert.ok(Date.now() - started < 15000);
  assert.ok(!out.stdout.includes('unreachable'));
});

test('put stores texts under <runKey>:t<n>; read returns them, also after the run ended', async () => {
  const port = make();
  const run = await port.begin('run:9');
  assert.equal(await run.put('hello'), 'run:9:t1');
  assert.equal(await run.put('world'), 'run:9:t2');
  await run.end('completed');
  assert.equal(await port.read?.('run:9:t1'), 'hello');
  assert.equal(await port.read?.('run:9:t2'), 'world');
  assert.equal(await port.read?.('run:9:t3'), undefined);
  assert.equal(await port.read?.('other:t1'), undefined);
  assert.equal(await port.read?.('garbage'), undefined);
  assert.equal(await port.read?.('constructor:t1'), undefined);
  assert.equal(await (await port.begin('run:9')).put('again'), 'run:9:t3');
});

test('maxRuns drops the oldest ended runs first and never a run in progress', async () => {
  const port = make(2);
  const a = await port.begin('a');
  await a.put('text-a');
  await a.end('completed');
  const b = await port.begin('b');
  await b.put('text-b');
  const c = await port.begin('c');
  assert.equal(await port.read?.('a:t1'), undefined);
  assert.equal(await port.read?.('b:t1'), 'text-b');
  await c.end('failed');
  await b.end('completed');
  const d = await port.begin('d');
  assert.equal(await port.read?.('c:t1'), undefined);
  await d.put('text-d');
  assert.equal(await port.read?.('b:t1'), 'text-b');
  assert.equal(await port.read?.('d:t1'), 'text-d');
});

test('all runs in progress are kept even above maxRuns', async () => {
  const port = make(1);
  const a = await port.begin('a');
  await port.begin('b');
  assert.equal(await a.put('x'), 'a:t1');
  assert.equal(await port.read?.('a:t1'), 'x');
});

test('a run that ended waiting is dropped after the completed ones, and resumes when begun again', async () => {
  const port = make(2);
  const w = await port.begin('w');
  await w.step('s', async () => 1);
  await w.end('waiting');
  const x = await port.begin('x');
  await x.end('completed');
  await port.begin('y');
  assert.equal(await (await port.begin('w')).step('s', async () => 2), 1);
  assert.equal(await (await port.begin('x')).step('s', async () => 3), 3);
});

test('invalid options and keys', async () => {
  assert.throws(() => make(0), /maxRuns/);
  assert.throws(() => make(1.5), /maxRuns/);
  await assert.rejects(make().begin(''), TypeError);
  const run = await make().begin('r');
  await assert.rejects(run.put(1 as never), TypeError);
});

test('remember and recall keep a JSON clone per run, across begin of the same run', async () => {
  const port = make();
  const run = await port.begin('r1');
  assert.equal(await run.recall('task'), undefined);
  const value = { id: 't-1', list: [1] };
  await run.remember('task', value);
  value.list.push(2);
  const got = (await run.recall('task')) as typeof value;
  assert.deepEqual(got, { id: 't-1', list: [1] });
  got.list.push(3);
  assert.deepEqual(await run.recall('task'), { id: 't-1', list: [1] });
  assert.deepEqual(await (await port.begin('r1')).recall('task'), { id: 't-1', list: [1] });
  assert.equal(await (await port.begin('r2')).recall('task'), undefined);
  await run.remember('task', 'next');
  assert.equal(await run.recall('task'), 'next');
});

test('remember rejects a value without a JSON form and an empty key; kept values go with the dropped run', async () => {
  const port = make(1);
  const run = await port.begin('a');
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  await assert.rejects(run.remember('k', loop));
  await assert.rejects(run.remember('', 1), /key/);
  await run.remember('k', 1);
  await run.end('completed');
  await port.begin('b');
  assert.equal(await run.recall('k'), 1);
  assert.equal(await (await port.begin('a')).recall('k'), undefined);
});

test('signal is first wins: a second signal of a name, before or after its wait, is refused and changes nothing', async () => {
  const port = make();
  const run = await port.begin('r');
  assert.equal(await port.signal('r', 'reply', 'first'), true);
  assert.equal(await port.signal('r', 'reply', 'second'), false);
  assert.equal(await run.wait('reply', soon(5000)), 'first');
  assert.equal(await port.signal('r', 'reply', 'third'), false);
  assert.equal(await (await port.begin('r')).wait('reply', soon(5000)), 'first');
});

// Resumes through a system: one reply per wait. -------------------------------------------------------------------

/** A system of one member `D` that waits for input and continues through `resume`, journaled by `journal`. */
async function waitingSystem(journal: AdapterDescriptor, options: Record<string, unknown> = {}) {
  const resumed: string[] = [];
  const invoked: string[] = [];
  const maps = { technology: 'test' };
  const tiers: ('prototype' | 'production')[] = ['prototype'];
  const member = defineAdapter({
    fills: 'MemberPort', name: 'waiting-member', maps, tiers, portVersion: PORT_VERSIONS.MemberPort,
    create: (_o, ctx): MemberPort => ({
      name: ctx.name,
      describe: async () => ({ id: ctx.name, name: ctx.name, description: ctx.name, skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: false } }),
      invoke: async (input) => {
        invoked.push(inputText(input));
        return { status: 'waiting', output: '', reason: { code: 'needs_input', layer: 'member' }, taskRef: 'task-1' };
      },
      resume: async (_ref, input) => {
        resumed.push(input === undefined ? '-' : inputText(input));
        await new Promise((done) => setTimeout(done, 20));
        return { status: 'completed', output: `D:${input === undefined ? '-' : inputText(input)}` };
      },
    }),
  });
  const topology = defineAdapter({
    fills: 'TopologyPort', name: 'one-call', maps, tiers, portVersion: PORT_VERSIONS.TopologyPort,
    create: (): TopologyPort => ({ name: 'one-call', kinds: ['sequence'], bind: () => ({ run: async (input, scope) => (await scope.call('D', input, { node: 'root' })).result }) }),
  });
  const attribution = defineAdapter({
    fills: 'AttributionPort', name: 'no-attribution', maps, tiers, portVersion: PORT_VERSIONS.AttributionPort,
    create: () => ({ name: 'no-attribution', attribute: async () => [] }),
  });
  const all = [member, topology, attribution, journal] as unknown as AdapterDescriptor[];
  const config = resolveConfig({
    system: { name: 'waits' },
    members: { D: { adapter: 'waiting-member' } },
    ports: { topology: { adapter: 'one-call' }, execution: { adapter: (journal as { name: string }).name, options }, attribution: { adapter: 'no-attribution' } },
    topology: { kind: 'sequence', steps: ['D'] },
  }, { cwd: process.cwd() });
  const system = await assemble(config, {
    host: prototypeHost({ quiet: true }),
    resolveAdapter: async (fills, name) => {
      const found = all.find((d) => d.fills === fills && d.name === name);
      if (!found) throw new Error('is not installed');
      return found;
    },
  });
  return { system, resumed, invoked };
}

test('two concurrent resumes of one run: the first runs it, the other fails as in progress; the member resumes once', async () => {
  const { system, resumed } = await waitingSystem(adapter as unknown as AdapterDescriptor, {});
  assert.equal((await system.run('hi', { runId: 'c1' })).status, 'waiting');
  const [a, b] = await Promise.all([system.resume('c1', { input: 'ALICE' }), system.resume('c1', { input: 'BOB' })]);
  assert.deepEqual([a.status, a.output], ['completed', 'D:ALICE']);
  assert.deepEqual([b.status, b.reason?.code, b.reason?.layer, b.reason?.detail], ['failed', 'error', 'execution', 'run c1 is in progress']);
  assert.deepEqual(resumed, ['ALICE']);
  await system.close();
});

test('a resume refused while another holds the run neither ends it nor lets maxRuns drop it mid-resume', async () => {
  const alice = { id: 'alice', kind: 'user' as const, roles: [], scopes: [] };
  const mallory = { id: 'mallory', kind: 'user' as const, roles: [], scopes: [] };
  const { system, resumed, invoked } = await waitingSystem(adapter as unknown as AdapterDescriptor, { maxRuns: 1 });
  assert.equal((await system.run('hi', { runId: 'x1', caller: alice })).status, 'waiting');
  const first = system.resume('x1', { input: 'ok' }, { caller: alice });
  await new Promise((done) => setTimeout(done, 5));
  const refused = await system.resume('x1', { input: 'evil' }, { caller: mallory });
  assert.equal(refused.reason?.detail, 'run x1 is in progress');
  // A new run beyond maxRuns while x1 is held: x1 is not dropped.
  assert.equal((await system.run('other', { runId: 'y1' })).status, 'waiting');
  const done = await first;
  assert.deepEqual([done.status, done.output], ['completed', 'D:ok'], JSON.stringify(done.reason));
  const again = await system.run('hi', { runId: 'x1', caller: alice });
  assert.deepEqual([again.status, again.output], ['completed', 'D:ok']);
  assert.deepEqual([invoked, resumed], [['hi', 'other'], ['ok']]);
  await system.close();
});
