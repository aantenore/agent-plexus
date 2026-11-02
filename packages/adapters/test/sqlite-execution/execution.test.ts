import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  assemble, defineAdapter, inputText, isRunBusy, PORT_VERSIONS, prototypeHost, resolveConfig, type AdapterDescriptor, type MemberPort,
  type TopologyPort,
} from '@agent-plexus/core';
import { adapter, createSqliteExecution, limits, type SqliteExecutionOptions } from '../../src/sqlite-execution/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'sqlite-execution-'));
const opened: { close(): Promise<void> }[] = [];
let files = 0;
after(async () => {
  await Promise.allSettled(opened.map((p) => p.close()));
  rmSync(dir, { recursive: true, force: true });
});

const fresh = () => join(dir, `j${++files}.db`);
const open = (options: Partial<SqliteExecutionOptions> = {}) => {
  const port = createSqliteExecution({ path: fresh(), ...options }, { name: 'execution', cwd: dir });
  opened.push(port);
  return port;
};
const make = (maxRuns?: number) => open(maxRuns === undefined ? {} : { maxRuns });
const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
// wait arms an unref'd timer on purpose; a ref'd interval keeps the event loop (and the test runner) alive while a test awaits one.
const alive = async <T>(pending: Promise<T>): Promise<T> => {
  const keep = setInterval(() => {}, 1000);
  try { return await pending; } finally { clearInterval(keep); }
};

test('adapter descriptor and limits', () => {
  assert.equal(adapter.fills, 'ExecutionPort');
  assert.deepEqual(adapter.tiers, ['prototype', 'production']);
  assert.equal(limits.maxRuns.default, 1000);
  assert.equal(limits.busyTimeoutMs.default, 5000);
  assert.equal(limits.leaseMs.default, 600_000);
  assert.equal(adapter.limits, limits);
  assert.deepEqual(adapter.optionsSchema?.required, ['path']);
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

test('a signal buffered before the wait is returned even when the wait deadline has already passed', async () => {
  const path = fresh();
  const first = createSqliteExecution({ path }, { name: 'execution', cwd: dir });
  const run = await first.begin('r');
  const past = new Date(Date.now() - 60_000).toISOString();
  await first.signal('r', 'reply', { input: 'here' });
  assert.deepEqual(await run.wait('reply', past), { input: 'here' });
  await first.signal('r', 'later', { approved: true });
  const second = await restart(first, path);
  assert.deepEqual(await (await second.begin('r')).wait('later', past), { approved: true });
});

test('wait gives undefined at the deadline, and a late signal is ignored', async () => {
  const port = make();
  const run = await port.begin('r');
  const started = Date.now();
  assert.equal(await alive(run.wait('slow', soon(20))), undefined);
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
  const db = fresh();
  const code = `
    import { createSqliteExecution } from ${JSON.stringify(new URL('../../src/sqlite-execution/index.ts', import.meta.url).href)};
    const run = await createSqliteExecution({ path: ${JSON.stringify(db)} }, { name: 'e', cwd: '/' }).begin('r');
    await run.wait('w', new Date(Date.now() + 60000).toISOString());
    console.log('unreachable');
  `;
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
  assert.throws(() => open({ busyTimeoutMs: -1 }), /busyTimeoutMs/);
  assert.throws(() => open({ path: '' }), /path/);
  assert.throws(() => open({ path: undefined as never }), /path/);
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

test('remember rejects a value without a JSON form and an empty key', async () => {
  const run = await make().begin('a');
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  await assert.rejects(run.remember('k', loop), TypeError);
  await assert.rejects(run.remember('', 1), /key/);
  await run.remember('k', 1);
  assert.equal(await run.recall('k'), 1);
});

test('kept values go with the dropped run, and a dropped run takes no more writes', async () => {
  const port = make(1);
  const run = await port.begin('a');
  await run.remember('k', 1);
  await run.end('completed');
  await port.begin('b');
  assert.equal(await run.recall('k'), undefined);
  await assert.rejects(run.step('s', async () => 1), /dropped/);
  await assert.rejects(run.put('x'), /dropped/);
  await assert.rejects(run.remember('k', 2), /dropped/);
  await assert.rejects(run.end('failed'), /dropped/);
  assert.equal(await (await port.begin('a')).recall('k'), undefined);
});


// Durability: a closed adapter and a new one on the same file stand for a process restart. ------------------------

const restart = async (port: { close(): Promise<void> }, path: string) => {
  await port.close();
  const next = createSqliteExecution({ path }, { name: 'execution', cwd: dir });
  opened.push(next);
  return next;
};

test('steps, kept values, texts and the run status survive a restart', async () => {
  const path = fresh();
  const first = createSqliteExecution({ path }, { name: 'execution', cwd: dir });
  const run = await first.begin('run:1');
  assert.deepEqual(await run.step('a', async () => ({ n: 1 })), { n: 1 });
  await run.remember('call:x:0:task', 'task-42');
  const ref = await run.put('hello');
  await run.end('waiting');

  const second = await restart(first, path);
  assert.equal(await second.read?.(ref), 'hello');
  const resumed = await second.begin('run:1');
  assert.equal(await resumed.recall('call:x:0:task'), 'task-42');
  assert.deepEqual(await resumed.step('a', async () => ({ n: 2 })), { n: 1 });
  assert.equal(await resumed.put('again'), 'run:1:t2');

  // Begun again, the run keeps its last status until it ends, and this instance holds it.
  const db = new DatabaseSync(path, { readOnly: true });
  const status = db.prepare('SELECT status, ended_seq, lease IS NOT NULL AS held FROM runs WHERE key = ?');
  assert.deepEqual({ ...status.get('run:1') }, { status: 'waiting', ended_seq: 1, held: 1 });
  db.close();
  await resumed.end('completed');
  await second.close();
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal((check.prepare('SELECT status FROM runs WHERE key = ?').get('run:1') as { status: string }).status, 'completed');
  check.close();
});

test('a stored step replays after a restart without calling the function', async () => {
  const path = fresh();
  const first = createSqliteExecution({ path }, { name: 'execution', cwd: dir });
  let calls = 0;
  await (await first.begin('r')).step('s', async () => ({ calls: ++calls }));
  await (await first.begin('r')).step('gone', async () => undefined);
  const second = await restart(first, path);
  const run = await second.begin('r');
  assert.deepEqual(await run.step('s', async () => ({ calls: ++calls })), { calls: 1 });
  assert.equal(await run.step('gone', async () => ++calls), undefined);
  assert.equal(calls, 1);
});

test('a signal sent before the waiter exists reaches a wait made after a restart', async () => {
  const path = fresh();
  const first = createSqliteExecution({ path }, { name: 'execution', cwd: dir });
  await first.begin('r');
  await first.signal('r', 'approval', { ok: true });
  await first.signal('r', 'nothing', undefined);
  const second = await restart(first, path);
  const run = await second.begin('r');
  assert.deepEqual(await run.wait('approval', soon(5000)), { ok: true });
  assert.equal(await run.wait('nothing', soon(5000)), undefined);
  const third = await restart(second, path);
  const again = await third.begin('r');
  assert.deepEqual(await again.wait('approval', soon(5000)), { ok: true });
  await third.signal('r', 'approval', 'late');
  assert.deepEqual(await again.wait('approval', soon(5000)), { ok: true });
});

test('a settled wait, a deadline result included, survives a restart', async () => {
  const path = fresh();
  const first = createSqliteExecution({ path }, { name: 'execution', cwd: dir });
  const run = await first.begin('r');
  assert.equal(await alive(run.wait('slow', soon(10))), undefined);
  const second = await restart(first, path);
  await second.signal('r', 'slow', 'late');
  assert.equal(await (await second.begin('r')).wait('slow', soon(5000)), undefined);
});

test('a signal stored by another instance reaches a waiter at its deadline', async () => {
  const path = fresh();
  const a = createSqliteExecution({ path }, { name: 'a', cwd: dir });
  const b = createSqliteExecution({ path }, { name: 'b', cwd: dir });
  opened.push(a, b);
  const run = await a.begin('r');
  const waiting = run.wait('n', soon(40));
  await b.signal('r', 'n', 'from-b');
  assert.equal(await alive(waiting), 'from-b');
});

test('eviction survives a restart: ended runs go oldest first, waiting ones last', async () => {
  const path = fresh();
  const first = createSqliteExecution({ path, maxRuns: 2 }, { name: 'execution', cwd: dir });
  const w = await first.begin('w');
  await w.put('text-w');
  await w.end('waiting');
  const x = await first.begin('x');
  await x.put('text-x');
  await x.end('completed');
  await first.close();
  const second = createSqliteExecution({ path, maxRuns: 2 }, { name: 'execution', cwd: dir });
  opened.push(second);
  await second.begin('y');
  assert.equal(await second.read?.('x:t1'), undefined);
  assert.equal(await second.read?.('w:t1'), 'text-w');
  await second.close();
  const lower = createSqliteExecution({ path, maxRuns: 1 }, { name: 'execution', cwd: dir });
  opened.push(lower);
  await (await lower.begin('y')).end('failed');
  assert.equal(await lower.read?.('w:t1'), 'text-w');
  await lower.begin('z');
  assert.equal(await lower.read?.('w:t1'), undefined);
});

test('a result that is not JSON is rejected and stores nothing', async () => {
  const port = make();
  const run = await port.begin('r');
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  await assert.rejects(run.step('c', async () => loop), /result of step "c" is not JSON-serialisable/);
  await assert.rejects(run.step('big', async () => 1n), TypeError);
  await assert.rejects(port.signal('r', 's', loop), TypeError);
  assert.equal(await run.step('c', async () => 'fine'), 'fine');
  assert.equal(await run.step('big', async () => 'fine'), 'fine');
});

test('the path resolves against cwd and its folder is created; :memory: works', async () => {
  const path = join('nested', 'deeper', 'journal.db');
  const port = createSqliteExecution({ path }, { name: 'execution', cwd: dir });
  opened.push(port);
  await (await port.begin('r')).put('x');
  assert.ok(existsSync(join(dir, path)));
  const memory = createSqliteExecution({ path: ':memory:' }, { name: 'execution', cwd: dir });
  opened.push(memory);
  assert.equal(await (await memory.begin('r')).put('x'), 'r:t1');
});

test('the database uses WAL and carries a schema version; a newer one is refused', async () => {
  const path = fresh();
  await open({ path }).begin('r');
  const db = new DatabaseSync(path);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  db.exec('PRAGMA user_version = 99');
  db.close();
  assert.throws(() => createSqliteExecution({ path }, { name: 'execution', cwd: dir }), /schema version 99/);
});

test('close fails the waits still pending and closes the database', async () => {
  const port = createSqliteExecution({ path: fresh() }, { name: 'execution', cwd: dir });
  const run = await port.begin('r');
  const waiting = run.wait('w', soon(5000));
  await port.close();
  await assert.rejects(waiting, /closed while waiting/);
  await port.close();
  await assert.rejects(port.begin('r'));
});

test('signal is first wins, across instances on one file: a second signal of a name is refused and changes nothing', async () => {
  const path = fresh();
  const one = createSqliteExecution({ path }, { name: 'execution', cwd: dir });
  const two = createSqliteExecution({ path }, { name: 'execution', cwd: dir });
  opened.push(one, two);
  const run = await one.begin('r');
  assert.equal(await one.signal('r', 'reply', 'first'), true);
  assert.equal(await two.signal('r', 'reply', 'second'), false);
  assert.equal(await one.signal('r', 'reply', 'third'), false);
  assert.equal(await run.wait('reply', soon(5000)), 'first');
  assert.equal(await two.signal('r', 'reply', 'late'), false);
  const waiting = run.wait('other', soon(5000));
  assert.equal(await one.signal('r', 'other', 'to the waiter'), true);
  assert.equal(await one.signal('r', 'other', 'again'), false);
  assert.equal(await waiting, 'to the waiter');
});

test('two begin of one run in a process share a step in flight: the function runs once', async () => {
  const port = make();
  const [a, b] = await Promise.all([port.begin('r'), port.begin('r')]);
  let calls = 0;
  const work = async () => {
    calls++;
    await new Promise((done) => setTimeout(done, 10));
    return { n: calls };
  };
  assert.deepEqual(await Promise.all([a.step('s', work), b.step('s', work)]), [{ n: 1 }, { n: 1 }]);
  assert.equal(calls, 1);
});

// Resumes through a system: one reply per wait. -------------------------------------------------------------------

/** A system of one member `D` that waits for input and continues through `resume`, journaled by `journal`. */
async function waitingSystem(journal: AdapterDescriptor, options: Record<string, unknown> = {}) {
  const resumed: string[] = [];
  const invoked: string[] = [];
  const cancelled: string[] = [];
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
      cancel: async (ref) => {
        cancelled.push(ref);
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
  return { system, resumed, invoked, cancelled };
}

test('two concurrent resumes of one run: the first runs it, the other fails as in progress; the member resumes once', async () => {
  const { system, resumed } = await waitingSystem(adapter as unknown as AdapterDescriptor, { path: fresh() });
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
  const { system, resumed, invoked } = await waitingSystem(adapter as unknown as AdapterDescriptor, { path: fresh(), maxRuns: 1 });
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

// One instance holds a run at a time ---------------------------------------------------------------------------------

const busy = (err: unknown) => isRunBusy(err) && /run "r" is held by another invocation/.test((err as Error).message);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const instance = (path: string, options: Partial<SqliteExecutionOptions> = {}) => {
  const port = createSqliteExecution({ path, ...options }, { name: 'execution', cwd: dir });
  opened.push(port);
  return port;
};

test('begin holds the run: another instance on the file is refused with RUN_BUSY until the run ends, is let go of or the holder closes', async () => {
  const path = fresh();
  const [a, b] = [instance(path), instance(path)];
  const run = await a.begin('r');
  assert.ok(await (await a.begin('r')).recall('none') === undefined, 'the holder may begin it again');
  await assert.rejects(b.begin('r'), busy);
  await run.end('waiting');
  const held = await b.begin('r');
  await assert.rejects(a.begin('r'), busy);
  await held.release!();
  await a.begin('r');
  await assert.rejects(b.begin('r'), busy);
  await a.close();
  await (await b.begin('r')).end('completed');
});

test('release lets go of the run without a status: the last one stays and the run can still be dropped', async () => {
  const path = fresh();
  const port = instance(path, { maxRuns: 1 });
  const run = await port.begin('r');
  await run.put('text-r');
  await run.end('waiting');
  await (await port.begin('r')).release!();
  const db = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual({ ...db.prepare('SELECT status, ended_seq, lease, lease_until FROM runs WHERE key = ?').get('r') }, { status: 'waiting', ended_seq: 1, lease: null, lease_until: null });
  db.close();
  await port.begin('s');
  assert.equal(await port.read?.('r:t1'), undefined);
});

test('a run held by an invocation is never dropped by maxRuns, whatever its last status', async () => {
  const port = instance(fresh(), { maxRuns: 1 });
  const w = await port.begin('w');
  await w.put('text-w');
  await w.end('completed');
  const held = await port.begin('w');
  await (await port.begin('x')).end('completed');
  assert.equal(await port.read?.('w:t1'), 'text-w');
  assert.equal(await held.put('more'), 'w:t2');
  await held.end('completed');
});

test('a hold expires leaseMs after its last write: another instance takes the run over and the old holder can no longer write', async () => {
  const path = fresh();
  const slow = instance(path, { leaseMs: 60 });
  const other = instance(path);
  const run = await slow.begin('r');
  for (let i = 0; i < 3; i++) {
    await sleep(30);
    await run.remember('beat', i);
  }
  await assert.rejects(other.begin('r'), busy, 'each write extends the hold');
  await sleep(90);
  const taken = await other.begin('r');
  await assert.rejects(run.remember('late', 1), busy);
  await assert.rejects(run.step('late', async () => 1), busy);
  await assert.rejects(run.end('failed'), busy);
  assert.equal(await taken.recall('beat'), 2);
  await taken.end('completed');
});

test('a file of schema version 1 is upgraded to 2 and keeps its runs', async () => {
  const path = fresh();
  const old = instance(path);
  const run = await old.begin('r');
  assert.equal(await run.step('a', async () => 1), 1);
  await run.end('waiting');
  await old.close();
  const db = new DatabaseSync(path);
  db.exec('ALTER TABLE runs DROP COLUMN lease; ALTER TABLE runs DROP COLUMN lease_until; PRAGMA user_version = 1;');
  db.close();
  const upgraded = instance(path);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  check.close();
  const resumed = await upgraded.begin('r');
  assert.equal(await resumed.step('a', async () => 2), 1);
  await assert.rejects(instance(path).begin('r'), busy);
  await resumed.end('completed');
});

test('invalid leaseMs is refused', () => {
  for (const leaseMs of [0, 1.5, -1]) assert.throws(() => createSqliteExecution({ path: fresh(), leaseMs }, { name: 'execution', cwd: dir }), /leaseMs must be an integer of at least 1/);
});

test('two systems on one file: a resume while the other system holds the run fails as in progress', async () => {
  const path = fresh();
  const one = await waitingSystem(adapter as unknown as AdapterDescriptor, { path });
  const two = await waitingSystem(adapter as unknown as AdapterDescriptor, { path });
  assert.equal((await one.system.run('hi', { runId: 'p1' })).status, 'waiting');
  const first = one.system.resume('p1', { input: 'ONE' });
  await sleep(5);
  const refused = await two.system.resume('p1', { input: 'TWO' });
  assert.deepEqual([refused.status, refused.reason?.code, refused.reason?.layer, refused.reason?.detail], ['failed', 'error', 'execution', 'run p1 is in progress']);
  assert.deepEqual([(await first).status, one.resumed, two.resumed], ['completed', ['ONE'], []]);
  await one.system.close();
  await two.system.close();
});

test('a process that delivered a reply and died before keeping its claim: once its hold expires the next resume goes on with that reply', async () => {
  const path = fresh();
  const { system, resumed, invoked } = await waitingSystem(adapter as unknown as AdapterDescriptor, { path });
  assert.equal((await system.run('hi', { runId: 'crash1' })).status, 'waiting');
  // The dying process: it began the run, delivered its reply, and never ended or let go.
  const dying = instance(path, { leaseMs: 200 });
  await dying.begin('crash1');
  assert.equal(await dying.signal('crash1', 'call:root:0:reply:0', { input: 'LOST' }), true);
  assert.equal((await system.resume('crash1', { input: 'AGAIN' })).reason?.detail, 'run crash1 is in progress');
  await sleep(250);
  const res = await system.resume('crash1', { input: 'AGAIN' });
  assert.deepEqual([res.status, res.output], ['completed', 'D:LOST'], JSON.stringify(res.reason));
  assert.deepEqual([invoked, resumed], [['hi'], ['LOST']]);
  await system.close();
});

test('a cancelled run stays cancelled after a restart: the member task was cancelled once, and the run is neither resumed nor run again', async () => {
  const path = fresh();
  const alice = { id: 'alice', kind: 'user' as const, roles: [], scopes: [] };
  const first = await waitingSystem(adapter as unknown as AdapterDescriptor, { path });
  assert.equal((await first.system.run('hi', { runId: 'k1', caller: alice })).status, 'waiting');
  const res = await first.system.cancel('k1', { by: alice, reason: 'config changed' });
  assert.deepEqual([res.status, res.reason?.code, res.reason?.by, res.reason?.detail], ['stopped', 'cancelled', 'alice', 'config changed']);
  assert.deepEqual(first.cancelled, ['task-1']);
  await first.system.close();

  const db = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual({ ...(db.prepare('SELECT status, lease IS NOT NULL AS held FROM runs WHERE key = ?').get('k1') as object) }, { status: 'stopped', held: 0 });
  db.close();

  const second = await waitingSystem(adapter as unknown as AdapterDescriptor, { path });
  const again = await second.system.cancel('k1', { by: alice });
  assert.deepEqual([again.status, again.reason?.code, again.reason?.detail], ['stopped', 'cancelled', 'config changed']);
  const resumed = await second.system.resume('k1', { input: 'late' }, { caller: alice });
  assert.deepEqual([resumed.status, resumed.reason?.code, resumed.reason?.detail], ['failed', 'error', 'run k1 was cancelled']);
  const rerun = await second.system.run('hi', { runId: 'k1', caller: alice });
  assert.deepEqual([rerun.status, rerun.reason?.detail], ['failed', 'run k1 was cancelled']);
  assert.deepEqual([second.cancelled, second.resumed, second.invoked], [[], [], []]);
  await second.system.close();
});
