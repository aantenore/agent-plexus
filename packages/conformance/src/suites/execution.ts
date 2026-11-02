import { spawn } from 'node:child_process';
import { isRunBusy, type Execution, type ExecutionPort } from '@agent-plexus/core';
import { Checks, settle, sleep, uniqueId } from '../check.ts';

type Open = () => ExecutionPort | Promise<ExecutionPort>;

export interface ExecutionFixtures {
  /**
   * A new instance on the same store, as after a restart: durable adapters only. Steps, kept values and texts must
   * survive it. The suite ends or lets go of its runs before it reopens, and closes what it opened.
   */
  reopen?: Open;
  /** Another live instance on the same store, as another process would have: first-wins and the hold across instances. */
  secondInstance?: Open;
  /** The adapter holds runs across instances (`RUN_BUSY`); needs `secondInstance`. */
  exclusive?: boolean;
  /** Instances with a short hold on a fresh store, to check that a hold expires and that the old holder is refused. */
  lease?: { ms: number; open: Open };
  /**
   * A module exporting the adapter (`adapters`), to check in a child process that a pending wait does not keep the
   * process alive. `options` default to the options of `checkAdapter`.
   */
  alive?: { module: string; adapter?: string; options?: unknown; cwd?: string };
}

const past = () => new Date(Date.now() - 1000).toISOString();
const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
const far = () => soon(60_000);
const close = async (port: ExecutionPort | undefined) => { await (port as { close?(): Promise<void> } | undefined)?.close?.(); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Step names, kept keys, signal names and run ids the core uses. */
const STEP_NAMES = ['call:root.steps[1]:0', 'call:root.steps[1]:0#1', 'call:root.steps[1]:1', 'route:root:0', 'call:root.nodes.a#2:0', 'call:root.body#3:0'];
const KEPT_KEYS = ['run:owner', 'run:input', 'run:lineage', 'run:waiting', 'run:status', 'run:claimed', 'run:spent', 'call:root.steps[1]:0:task', 'call:root.steps[1]:0:attempt'];
const SIGNAL_NAME = 'call:root.steps[1]:0:reply:1';
const longRunId = (): string => {
  const base = `${uniqueId('long')}:run/#.[x]_é`;
  return (base + 'x'.repeat(128)).slice(0, 128);
};

/** Runs the ExecutionPort rules E1-E14 against an instance. */
export async function checkExecution(port: ExecutionPort, f: ExecutionFixtures = {}, c = new Checks()): Promise<Checks> {
  if (!c.expect('E1', typeof port?.begin === 'function' && typeof port.signal === 'function', 'begin and signal must be functions')) return c;

  await stepRuns(port, f, c);
  await stepValues(port, c);
  await stepThrows(port, c);
  await stepConcurrent(port, c);
  await keyFormats(port, c);
  await nested(port, c);
  await waits(port, c);
  await firstWins(port, f, c);
  await texts(port, c);
  await kept(port, f, c);
  await resumes(port, c);
  await hold(port, f, c);
  await release(port, f, c);
  await timers(port, f, c);
  return c;
}

async function open(c: Checks, rule: string, port: ExecutionPort, key: string): Promise<Execution | undefined> {
  return c.attempt(rule, `begin "${key}"`, () => port.begin(key));
}

/** E1: a step runs once and replays: in the same Execution, in a new begin, after a reopen. */
async function stepRuns(port: ExecutionPort, f: ExecutionFixtures, c: Checks): Promise<void> {
  const key = uniqueId('replay');
  const run = await open(c, 'E1', port, key);
  if (!run) return;
  c.expect('E1', run.runKey === key, `runKey must be the key begin was called with, got ${JSON.stringify(run.runKey)}`);
  let calls = 0;
  const fn = async () => ({ n: ++calls });
  const first = await c.attempt('E1', 'step', () => run.step('s', fn));
  const again = await c.attempt('E1', 'step again', () => run.step('s', fn));
  c.expect('E1', same(first, { n: 1 }) && same(again, { n: 1 }) && calls === 1, 'a step must run once and replay its stored result in the same execution');
  const resumed = await open(c, 'E1', port, key);
  if (resumed) {
    const replay = await c.attempt('E1', 'step after begin', () => resumed.step('s', fn));
    c.expect('E1', same(replay, { n: 1 }) && calls === 1, 'a new begin of the same key must replay the stored result');
  }
  await c.attempt('E1', 'end', () => run.end('completed'));
  if (!f.reopen) return c.skip('E1', 'replay after a restart: needs the reopen fixture (durable adapters)');
  const other = await c.attempt('E1', 'reopen', () => f.reopen!());
  if (!other) return;
  try {
    const later = await open(c, 'E1', other, key);
    if (!later) return;
    const replay = await c.attempt('E1', 'step after reopen', () => later.step('s', fn));
    c.expect('E1', same(replay, { n: 1 }) && calls === 1, 'a durable adapter must replay the stored result after a restart');
    await c.attempt('E1', 'end after reopen', () => later.end('completed'));
  } finally {
    await close(other);
  }
}

/** E2: results are JSON clones; undefined replays as undefined; a value JSON cannot hold rejects and stores nothing. */
async function stepValues(port: ExecutionPort, c: Checks): Promise<void> {
  const run = await open(c, 'E2', port, uniqueId('values'));
  if (!run) return;
  const source = { list: [1], at: new Date(0), gone: undefined as unknown };
  const first = await c.attempt('E2', 'step', () => run.step('clone', async () => source));
  const clone = JSON.parse(JSON.stringify(source));
  c.expect('E2', same(first, clone) && (first as { at?: unknown })?.at === clone.at, 'the result of a step must be its JSON clone, as a replay returns it');
  source.list.push(2);
  (first as { list?: number[] } | undefined)?.list?.push(3);
  const replay = await c.attempt('E2', 'replay', () => run.step('clone', async () => ({ list: [] })));
  c.expect('E2', same(replay, clone), 'changing the value a step returned, or its source, must not change the stored result');

  let calls = 0;
  const none = await c.attempt('E2', 'step returning undefined', () => run.step('undefined', async () => { calls++; return undefined; }));
  const noneAgain = await c.attempt('E2', 'replay of undefined', () => run.step('undefined', async () => { calls++; return 1; }));
  c.expect('E2', none === undefined && noneAgain === undefined && calls === 1, 'a step that returned undefined must replay as undefined without running again');

  const loop: Record<string, unknown> = {};
  loop.self = loop;
  await c.rejects('E2', 'step returning a cyclic value', () => run.step('cyclic', async () => loop));
  const after = await c.attempt('E2', 'step after a cyclic value', () => run.step('cyclic', async () => 'stored'));
  c.expect('E2', after === 'stored', 'a step whose value is not JSON must store nothing, so a later call runs again');
  await c.rejects('E2', 'step returning a bigint', () => run.step('bigint', async () => 1n));
  await c.attempt('E2', 'end', () => run.end('completed'));
}

/** E3: a throwing fn stores nothing and the step rejects; a later call of the step runs fn again. */
async function stepThrows(port: ExecutionPort, c: Checks): Promise<void> {
  const run = await open(c, 'E3', port, uniqueId('throws'));
  if (!run) return;
  let calls = 0;
  await c.rejects('E3', 'step whose fn throws', () => run.step('t', async () => { calls++; throw new Error('boom'); }));
  const later = await c.attempt('E3', 'step again', () => run.step('t', async () => { calls++; return 'ok'; }));
  c.expect('E3', later === 'ok' && calls === 2, 'a step whose fn threw must store nothing: a later call runs fn again');
  await c.attempt('E3', 'end', () => run.end('failed'));
}

/** E4: concurrent calls of one step share one run of fn. */
async function stepConcurrent(port: ExecutionPort, c: Checks): Promise<void> {
  const run = await open(c, 'E4', port, uniqueId('concurrent'));
  if (!run) return;
  let calls = 0;
  const fn = async () => { calls++; await sleep(20); return { v: calls }; };
  const both = await c.attempt('E4', 'two concurrent calls', () => Promise.all([run.step('s', fn), run.step('s', fn), run.step('s', fn)]));
  c.expect('E4', calls === 1 && !!both && both.every((v) => same(v, { v: 1 })), `concurrent calls of one step must share one run of fn (ran ${calls} times)`);
  await c.attempt('E4', 'end', () => run.end('completed'));
}

/** E5: the key formats the core uses, and run ids up to 128 characters. */
async function keyFormats(port: ExecutionPort, c: Checks): Promise<void> {
  const key = longRunId();
  c.rule('E5');
  const run = await open(c, 'E5', port, key);
  if (!run) return;
  for (const [i, name] of STEP_NAMES.entries()) await c.attempt('E5', `step "${name}"`, () => run.step(name, async () => i));
  for (const [i, name] of STEP_NAMES.entries()) {
    const replay = await c.attempt('E5', `replay "${name}"`, () => run.step(name, async () => -1));
    c.expect('E5', replay === i, `step "${name}" must keep its own result (got ${JSON.stringify(replay)}, expected ${i})`);
  }
  for (const [i, name] of KEPT_KEYS.entries()) await c.attempt('E5', `remember "${name}"`, () => run.remember(name, { i }));
  for (const [i, name] of KEPT_KEYS.entries()) {
    const value = await c.attempt('E5', `recall "${name}"`, () => run.recall(name));
    c.expect('E5', same(value, { i }), `kept key "${name}" must keep its own value`);
  }
  const kept = await c.attempt('E5', `signal "${SIGNAL_NAME}"`, () => port.signal(key, SIGNAL_NAME, { input: 'more' }));
  c.expect('E5', kept === true, `a signal on a run id of ${key.length} characters must be kept`);
  const reply = await c.attempt('E5', `wait "${SIGNAL_NAME}"`, () => run.wait(SIGNAL_NAME, past()));
  c.expect('E5', same(reply, { input: 'more' }), 'the reply signal must be returned by its wait');
  const ref = await c.attempt('E5', 'put', () => run.put('text'));
  if (ref !== undefined && port.read) c.expect('E5', (await c.attempt('E5', 'read', () => port.read!(ref))) === 'text', 'a text stored on a long run id must be read back');
  await c.attempt('E5', 'end', () => run.end('completed'));
}

/** E6: fn may call recall and remember on the same run while it runs, without a deadlock. */
async function nested(port: ExecutionPort, c: Checks): Promise<void> {
  const run = await open(c, 'E6', port, uniqueId('nested'));
  if (!run) return;
  const out = await c.attempt('E6', 'step that recalls and remembers', () => run.step('call:root:0', async () => {
    const before = await run.recall('call:root:0:task');
    await run.remember('call:root:0:task', 'task-1');
    return { before: before ?? null, after: await run.recall('call:root:0:task') };
  }));
  c.expect('E6', same(out, { before: null, after: 'task-1' }), 'recall and remember inside a step must work on the same run');
  // The core forgets a handle by keeping null: it must recall null, not nothing.
  await c.attempt('E6', 'remember null', () => run.remember('call:root:0:task', null));
  c.expect('E6', (await c.attempt('E6', 'recall null', () => run.recall('call:root:0:task'))) === null, 'a key kept as null must recall null');
  await c.attempt('E6', 'end', () => run.end('completed'));
}

/** E7: waits and deadlines. */
async function waits(port: ExecutionPort, c: Checks): Promise<void> {
  const key = uniqueId('waits');
  const run = await open(c, 'E7', port, key);
  if (!run) return;
  await c.attempt('E7', 'signal before its wait', () => port.signal(key, 'early', { v: 1 }));
  const early = await c.attempt('E7', 'wait with a past deadline', () => run.wait('early', past()));
  c.expect('E7', same(early, { v: 1 }), 'a signal that came before the wait must be returned, even with a deadline already passed');
  const replay = await c.attempt('E7', 'wait again', () => run.wait('early', past()));
  c.expect('E7', same(replay, { v: 1 }), 'a settled wait must return the same value again');

  const pending = run.wait('later', far());
  const second = run.wait('later', far());
  await sleep(10);
  await c.attempt('E7', 'signal a pending wait', () => port.signal(key, 'later', 'go'));
  const both = await c.attempt('E7', 'pending waits', () => Promise.all([pending, second]), 2000);
  c.expect('E7', same(both, ['go', 'go']), 'a later signal must release every pending wait of that name');

  const started = Date.now();
  const empty = await c.attempt('E7', 'wait until its deadline', () => run.wait('deadline', soon(50)), 3000);
  c.expect('E7', empty === undefined && Date.now() - started >= 40, 'a wait whose deadline passes must return undefined, not before the deadline');
  await c.rejects('E7', 'wait with an invalid untilAt', () => run.wait('invalid', 'not a date'));
  await c.attempt('E7', 'end', () => run.end('completed'));
}

/** E8: first signal wins, also when concurrent and across instances; an unknown run rejects. */
async function firstWins(port: ExecutionPort, f: ExecutionFixtures, c: Checks): Promise<void> {
  const key = uniqueId('first');
  const run = await open(c, 'E8', port, key);
  if (!run) return;
  const one = await c.attempt('E8', 'first signal', () => port.signal(key, 'n', 1));
  const two = await c.attempt('E8', 'second signal before the wait', () => port.signal(key, 'n', 2));
  c.expect('E8', one === true && two === false, `the first signal of a name must return true and a second false (got ${one}, ${two})`);
  const got = await c.attempt('E8', 'wait', () => run.wait('n', past()));
  c.expect('E8', got === 1, 'the wait must return the first signal');
  const three = await c.attempt('E8', 'signal after the wait', () => port.signal(key, 'n', 3));
  c.expect('E8', three === false, 'a signal after its wait settled must return false');
  const settledEmpty = await c.attempt('E8', 'wait to its deadline', () => run.wait('expired', soon(10)), 3000);
  const late = await c.attempt('E8', 'signal after the deadline', () => port.signal(key, 'expired', 'late'));
  c.expect('E8', settledEmpty === undefined && late === false, 'a signal after its wait settled at the deadline must return false');

  const race = await c.attempt('E8', 'two concurrent signals', () => Promise.all([port.signal(key, 'race', 'a'), port.signal(key, 'race', 'b')]));
  if (race) {
    c.expect('E8', race.filter(Boolean).length === 1, `of two concurrent signals exactly one must return true (got ${JSON.stringify(race)})`);
    const winner = await c.attempt('E8', 'wait after a race', () => run.wait('race', past()));
    c.expect('E8', winner === (race[0] ? 'a' : 'b'), 'the wait must return the signal that returned true');
  }
  await c.rejects('E8', 'signal on an unknown run', () => port.signal(uniqueId('unknown'), 'n', 1));

  if (!f.secondInstance) {
    c.skip('E8', 'first-wins across instances: needs the secondInstance fixture');
  } else {
    const other = await c.attempt('E8', 'second instance', () => f.secondInstance!());
    if (other) {
      try {
        for (let i = 0; i < 3; i++) {
          const name = `cross-${i}`;
          const pair = await c.attempt('E8', 'concurrent signals from two instances', () => Promise.all([port.signal(key, name, 'here'), other.signal(key, name, 'there')]));
          if (!pair) continue;
          c.expect('E8', pair.filter(Boolean).length === 1, `of two signals from two instances exactly one must return true (got ${JSON.stringify(pair)})`);
          const value = await c.attempt('E8', 'wait after signals from two instances', () => run.wait(name, past()));
          c.expect('E8', value === (pair[0] ? 'here' : 'there'), 'the wait must return the signal that returned true, whichever instance sent it');
        }
      } finally {
        await close(other);
      }
    }
  }
  await c.attempt('E8', 'end', () => run.end('completed'));
}

/** E9: put and read agree. */
async function texts(port: ExecutionPort, c: Checks): Promise<void> {
  const run = await open(c, 'E9', port, uniqueId('texts'));
  if (!run) return;
  const text = 'hello ✓ — "quoted"\nline two';
  const a = await c.attempt('E9', 'put', () => run.put(text));
  const b = await c.attempt('E9', 'put again', () => run.put(text));
  c.expect('E9', typeof a === 'string' && a.length > 0 && typeof b === 'string' && a !== b, 'put must return a new non-empty key for each text');
  await c.attempt('E9', 'end', () => run.end('completed'));
  if (!port.read) return c.skip('E9', 'read is not implemented');
  if (typeof a === 'string') c.expect('E9', (await c.attempt('E9', 'read', () => port.read!(a))) === text, 'read must return the stored text, also after the run ended');
  const missing = await c.attempt('E9', 'read an unknown key', () => port.read!(uniqueId('missing')));
  c.expect('E9', missing === undefined, 'read of an unknown key must be undefined');
}

/** E10: remember and recall. */
async function kept(port: ExecutionPort, f: ExecutionFixtures, c: Checks): Promise<void> {
  const key = uniqueId('kept');
  const run = await open(c, 'E10', port, key);
  if (!run) return;
  const value = { handle: 'task-1', list: [1] };
  await c.attempt('E10', 'remember', () => run.remember('k', value));
  value.list.push(2);
  const got = await c.attempt('E10', 'recall', () => run.recall('k'));
  c.expect('E10', same(got, { handle: 'task-1', list: [1] }), 'remember must keep a JSON clone of the value');
  (got as { list?: number[] } | undefined)?.list?.push(3);
  c.expect('E10', same(await c.attempt('E10', 'recall again', () => run.recall('k')), { handle: 'task-1', list: [1] }), 'recall must return a clone');
  await c.attempt('E10', 'remember again', () => run.remember('k', 'replaced'));
  c.expect('E10', (await c.attempt('E10', 'recall replaced', () => run.recall('k'))) === 'replaced', 'a later remember of a key must replace its value');
  c.expect('E10', (await c.attempt('E10', 'recall a missing key', () => run.recall('missing'))) === undefined, 'recall of a key never kept must be undefined');
  const other = await open(c, 'E10', port, uniqueId('kept-other'));
  if (other) {
    c.expect('E10', (await c.attempt('E10', 'recall in another run', () => other.recall('k'))) === undefined, 'keys of one run must not be visible from another');
    await c.attempt('E10', 'end other', () => other.end('completed'));
  }
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  await c.rejects('E10', 'remember a cyclic value', () => run.remember('cyclic', loop));
  await c.rejects('E10', 'remember an empty key', () => run.remember('', 1));
  const again = await open(c, 'E10', port, key);
  if (again) c.expect('E10', (await c.attempt('E10', 'recall after begin', () => again.recall('k'))) === 'replaced', 'a kept value must survive a new begin of the run');
  await c.attempt('E10', 'end', () => run.end('waiting'));
  if (!f.reopen) return c.skip('E10', 'kept values after a restart: needs the reopen fixture');
  const reopened = await c.attempt('E10', 'reopen', () => f.reopen!());
  if (!reopened) return;
  try {
    const later = await open(c, 'E10', reopened, key);
    if (later) {
      c.expect('E10', (await c.attempt('E10', 'recall after reopen', () => later.recall('k'))) === 'replaced', 'a kept value must survive a restart of a durable adapter');
      await c.attempt('E10', 'end after reopen', () => later.end('completed'));
    }
  } finally {
    await close(reopened);
  }
}

/** E11: begin resumes a run that ended, whatever its status, and resets nothing. */
async function resumes(port: ExecutionPort, c: Checks): Promise<void> {
  for (const status of ['waiting', 'completed', 'failed', 'stopped'] as const) {
    const key = uniqueId(`resume-${status}`);
    const run = await open(c, 'E11', port, key);
    if (!run) continue;
    await c.attempt('E11', 'step', () => run.step('s', async () => status));
    await c.attempt('E11', 'remember', () => run.remember('run:status', status));
    await c.attempt('E11', `end ${status}`, () => run.end(status));
    const again = await open(c, 'E11', port, key);
    if (!again) continue;
    const replay = await c.attempt('E11', 'step after begin', () => again.step('s', async () => 'ran again'));
    const value = await c.attempt('E11', 'recall after begin', () => again.recall('run:status'));
    c.expect('E11', replay === status && value === status, `begin of a run that ended ${status} must resume it without resetting its steps or kept values`);
    await c.attempt('E11', 'end', () => again.end(status));
  }
}

/** E12: an exclusive adapter holds a run across instances until end, release or close, and a hold expires. */
async function hold(port: ExecutionPort, f: ExecutionFixtures, c: Checks): Promise<void> {
  if (!f.exclusive) return c.skip('E12', 'the adapter does not hold runs across instances (fixture exclusive not set)');
  if (!f.secondInstance) return void c.fail('E12', 'an exclusive adapter needs the secondInstance fixture to be checked');
  const other = await c.attempt('E12', 'second instance', () => f.secondInstance!());
  if (!other) return;
  const third = await c.attempt('E12', 'third instance', () => f.secondInstance!());
  try {
    const key = uniqueId('hold');
    const held = await open(c, 'E12', port, key);
    if (!held) return;
    const busy = async (label: string) => {
      const err = await c.rejects('E12', label, () => other.begin(key));
      if (err !== undefined) c.expect('E12', isRunBusy(err), `${label}: must reject with code RUN_BUSY`);
    };
    await busy('begin while another instance holds the run');
    await c.attempt('E12', 'end', () => held.end('waiting'));
    const afterEnd = await c.attempt('E12', 'begin after end', () => other.begin(key));
    if (afterEnd) {
      const err = await c.rejects('E12', 'first instance begins while the second holds', () => port.begin(key));
      if (err !== undefined) c.expect('E12', isRunBusy(err), 'a begin while another instance holds must reject with RUN_BUSY');
      if (afterEnd.release) await c.attempt('E12', 'release', () => afterEnd.release!());
      else await c.attempt('E12', 'end', () => afterEnd.end('waiting'));
    }
    const afterRelease = await c.attempt('E12', 'begin after release', () => port.begin(key));
    if (afterRelease) await c.attempt('E12', 'end', () => afterRelease.end('waiting'));
    if (third) {
      const taken = await c.attempt('E12', 'third instance begins', () => third.begin(key));
      if (taken) {
        await busy('begin while a third instance holds the run');
        await c.attempt('E12', 'close the holder', () => close(third));
        const afterClose = await c.attempt('E12', 'begin after the holder closed', () => other.begin(key));
        if (afterClose) await c.attempt('E12', 'end', () => afterClose.end('completed'));
      }
    }
  } finally {
    await close(other);
    await close(third);
  }
  if (!f.lease) return c.skip('E12', 'hold expiry: needs the lease fixture');
  const a = await c.attempt('E12', 'lease instance', () => f.lease!.open());
  const b = await c.attempt('E12', 'second lease instance', () => f.lease!.open());
  try {
    if (!a || !b) return;
    const key = uniqueId('lease');
    const first = await open(c, 'E12', a, key);
    if (!first) return;
    const err = await c.rejects('E12', 'begin before the hold expired', () => b.begin(key));
    if (err !== undefined) c.expect('E12', isRunBusy(err), 'a begin before the hold expired must reject with RUN_BUSY');
    await sleep(f.lease.ms + 50);
    const taken = await c.attempt('E12', 'begin after the hold expired', () => b.begin(key));
    if (!taken) return;
    await c.rejects('E12', 'write of the old holder after a take-over', () => first.remember('k', 1));
    await c.rejects('E12', 'step of the old holder after a take-over', () => first.step('stale', async () => 1));
    await c.attempt('E12', 'end', () => taken.end('completed'));
  } finally {
    await close(a);
    await close(b);
  }
}

/** E13: an adapter that can reject with RUN_BUSY implements release, which lets go without ending the run. */
async function release(port: ExecutionPort, f: ExecutionFixtures, c: Checks): Promise<void> {
  const key = uniqueId('release');
  const run = await open(c, 'E13', port, key);
  if (!run) return;
  if (f.exclusive) c.expect('E13', typeof run.release === 'function', 'an adapter that holds runs (RUN_BUSY) must implement release');
  if (typeof run.release !== 'function') {
    await c.attempt('E13', 'end', () => run.end('completed'));
    return c.skip('E13', 'release is not implemented');
  }
  await c.attempt('E13', 'step', () => run.step('s', async () => 'kept'));
  await c.attempt('E13', 'release', () => run.release!());
  const again = await open(c, 'E13', port, key);
  if (!again) return;
  c.expect('E13', (await c.attempt('E13', 'replay after release', () => again.step('s', async () => 'ran again'))) === 'kept', 'release must keep the run as it was');
  await c.attempt('E13', 'end', () => again.end('completed'));
}

/** E14: a pending wait does not keep the process alive; close settles the pending waits when the adapter has close. */
async function timers(port: ExecutionPort, f: ExecutionFixtures, c: Checks): Promise<void> {
  if (!f.alive) c.skip('E14', 'process liveness: needs the alive fixture (the module that exports the adapter)');
  else await alive(f.alive, c, c.options);
  const closing = port as ExecutionPort & { close?(): Promise<void> };
  if (typeof closing.close !== 'function') return c.skip('E14', 'close is not implemented');
  if (!f.reopen && !f.secondInstance) return c.skip('E14', 'close with a pending wait: needs a reopen or secondInstance fixture to close an instance of its own');
  const own = await c.attempt('E14', 'instance to close', () => (f.secondInstance ?? f.reopen)!());
  if (!own) return;
  const run = await open(c, 'E14', own, uniqueId('close'));
  if (!run) return void (await close(own));
  const pending = settle(() => run.wait('w', far()), 2000);
  await sleep(10);
  await c.attempt('E14', 'close', () => close(own));
  const out = await pending;
  c.expect('E14', !('timedOut' in out && out.timedOut), 'close must settle the pending waits (resolve or reject them)');
}

async function alive(fixture: NonNullable<ExecutionFixtures['alive']>, c: Checks, options: unknown): Promise<void> {
  const name = fixture.adapter;
  const code = `
    const mod = await import(${JSON.stringify(fixture.module)});
    const list = Array.isArray(mod.adapters) ? mod.adapters : [mod.adapter];
    const d = list.find((a) => a && a.fills === 'ExecutionPort' && (${JSON.stringify(name ?? null)} === null || a.name === ${JSON.stringify(name ?? null)}));
    const telemetry = { span: (n, a, fn) => fn({ set() {}, event() {} }), event() {}, metric() {} };
    const port = await d.create(${JSON.stringify(fixture.options ?? options ?? {})}, { system: 'conformance', name: 'execution', cwd: ${JSON.stringify(fixture.cwd ?? process.cwd())}, env: process.env, telemetry });
    const run = await port.begin('conformance-alive');
    await run.wait('w', new Date(Date.now() + 60000).toISOString());
    console.log('unreachable');
  `;
  const flags = process.execArgv.filter((a) => a.startsWith('--conditions') || a.startsWith('-C'));
  const started = Date.now();
  const out = await new Promise<{ stdout: string; code: number | null; error?: Error }>((done) => {
    const child = spawn(process.execPath, [...flags, '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (error) => { clearTimeout(timer); done({ stdout, code: null, error }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ stdout: stdout + (code !== 0 && code !== 13 ? `\n${stderr}` : ''), code });
    });
  });
  const ms = Date.now() - started;
  if (out.error) return void c.fail('E14', `child process failed to start: ${out.error.message}`);
  c.expect('E14', ms < 15_000 && !out.stdout.includes('unreachable'), `a pending wait must not keep the process alive (exited after ${ms} ms)`);
  c.expect('E14', out.code === 0 || out.code === 13, `the child process failed (exit ${out.code}): ${out.stdout.trim().split('\n').slice(-3).join(' | ')}`);
}
