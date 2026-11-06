import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assemble, defineAdapter, inputText, loadDescriptor, PORT_VERSIONS, prototypeHost, resolveConfig, type AdapterDescriptor, type Host,
  type MemberPort, type System, type TopologySpec,
} from '@agent-plexus/core';
import { resumeHint } from '../src/format.ts';
import { main } from '../src/main.ts';
import { captureIo } from './helpers.ts';

/**
 * Members that count their calls: `ask` waits for input on the first call and answers with the reply once resumed.
 * The counts live in the test, so they span every system assembled over the same journal file.
 */
function countingMember(calls: string[]): AdapterDescriptor {
  return defineAdapter<'MemberPort', { ask?: boolean }>({
    fills: 'MemberPort',
    name: 'counting-member',
    maps: { technology: 'test fixture' },
    portVersion: PORT_VERSIONS.MemberPort,
    tiers: ['prototype'],
    create: (options, ctx): MemberPort => ({
      name: ctx.name,
      describe: async () => ({ id: ctx.name, name: ctx.name, description: ctx.name, skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: false } }),
      invoke: async (input) => {
        calls.push(`invoke:${ctx.name}`);
        return options.ask
          ? { status: 'waiting', output: '', reason: { code: 'needs_input', layer: 'member' }, taskRef: `task-${ctx.name}` }
          : { status: 'completed', output: `${ctx.name}(${inputText(input)})` };
      },
      resume: async (taskRef, input) => {
        calls.push(`resume:${ctx.name}`);
        return { status: 'completed', output: `${taskRef}: ${input === undefined ? '' : inputText(input)}` };
      },
    }),
  }) as unknown as AdapterDescriptor;
}

/** A host whose gate asks before `billing` until it has an answer, then follows it; a resume is the prototype host's. */
const askingHost = (): Host => {
  const host = prototypeHost({ quiet: true });
  return {
    ...host,
    gate: {
      ...host.gate,
      allow: async (q) => {
        if (q.action !== 'invoke') return host.gate.allow(q);
        if (q.member.id !== 'billing') return { effect: 'allow' };
        if (!q.answer) return { effect: 'ask', reason: 'approval pending' };
        return q.answer.approved ? { effect: 'allow' } : { effect: 'deny', reason: 'refused' };
      },
    },
  };
};

/**
 * A system on the sqlite journal at `path`: a new instance each call, as a new process would build it. The topology is
 * a sequence of the members unless given.
 */
async function open(dir: string, path: string, members: Record<string, { ask?: boolean }>, calls: string[], host?: Host, topology?: TopologySpec): Promise<System> {
  const fixture = countingMember(calls);
  const config = resolveConfig({
    system: { name: 'durable' },
    members: Object.fromEntries(Object.entries(members).map(([id, options]) => [id, { adapter: 'counting-member', options }])),
    ports: {
      topology: { adapter: 'basic-topology' },
      execution: { adapter: 'sqlite-execution', options: { path } },
      attribution: { adapter: 'rule-attribution' },
    },
    topology: topology ?? { kind: 'sequence', steps: Object.keys(members) },
  }, { cwd: dir });
  return assemble(config, {
    host: host ?? prototypeHost({ quiet: true }),
    resolveAdapter: async (fills, name, cwd) => (name === 'counting-member' ? fixture : loadDescriptor(fills, name, cwd)),
  });
}

const rowOf = (file: string, runId: string): { status: unknown; lease: unknown } | undefined => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT status, lease FROM runs WHERE key = ?').get(runId) as { status: unknown; lease: unknown } | undefined;
  } finally {
    db.close();
  }
};
const statusOf = (file: string, runId: string): unknown => rowOf(file, runId)?.status;

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-durable-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a member waiting for input is resumed by a new system on the same sqlite journal; completed steps are not called again', () =>
  inTempDir(async (dir) => {
    const file = join(dir, 'journal', 'runs.db');
    const calls: string[] = [];
    const members = { triage: {}, asker: { ask: true } };

    const first = await open(dir, file, members, calls);
    const started = await first.run('start', { runId: 'run-input' });
    await first.close();
    assert.deepEqual([started.status, started.reason?.code, started.reason?.layer], ['waiting', 'needs_input', 'member']);
    assert.equal(statusOf(file, 'run-input'), 'waiting');

    const second = await open(dir, file, members, calls);
    try {
      const resumed = await second.resume('run-input', { input: 'order 42' });
      assert.equal(resumed.status, 'completed', JSON.stringify(resumed.reason));
      assert.equal(resumed.output, 'task-asker: order 42');
      assert.deepEqual(calls, ['invoke:triage', 'invoke:asker', 'resume:asker']);
      assert.equal(statusOf(file, 'run-input'), 'completed');

      const late = await second.resume('run-input', { input: 'again' });
      assert.deepEqual([late.status, late.reason?.detail], ['failed', 'run run-input is not waiting']);
      assert.equal(statusOf(file, 'run-input'), 'completed', 'a refused resume leaves the stored status');
      assert.equal(calls.length, 3);
    } finally {
      await second.close();
    }
  }));

test('a gate ask is approved through a new system on the same sqlite journal; completed steps are not called again', () =>
  inTempDir(async (dir) => {
    const file = join(dir, 'runs.db');
    const calls: string[] = [];
    const members = { triage: {}, billing: {} };

    const first = await open(dir, file, members, calls, askingHost());
    const started = await first.run('start', { runId: 'run-gate' });
    await first.close();
    assert.deepEqual([started.status, started.reason?.code, started.reason?.layer], ['waiting', 'needs_input', 'host']);
    assert.deepEqual(calls, ['invoke:triage']);

    const second = await open(dir, file, members, calls, askingHost());
    try {
      const wrong = await second.resume('run-gate', { input: 'x' });
      assert.equal(wrong.reason?.detail, 'run run-gate waits for an approval');
      assert.equal(statusOf(file, 'run-gate'), 'waiting');
      const resumed = await second.resume('run-gate', { approved: true });
      assert.equal(resumed.status, 'completed', JSON.stringify(resumed.reason));
      assert.equal(resumed.output, 'billing(triage(start))');
      assert.deepEqual(calls, ['invoke:triage', 'invoke:billing']);
      assert.equal(statusOf(file, 'run-gate'), 'completed');
    } finally {
      await second.close();
    }
  }));

test('a graph that goes past a wait to a second one: the result, the kept wait and the resume all name the second', () =>
  inTempDir(async (dir) => {
    const file = join(dir, 'runs.db');
    const calls: string[] = [];
    const graph: TopologySpec = { kind: 'graph', start: 'X', nodes: { X: 'X', Y: 'Y' }, edges: [{ from: 'X', to: 'Y', when: { status: 'waiting' } }], end: ['X', 'Y'] };
    const first = await open(dir, file, { X: { ask: true }, Y: { ask: true } }, calls, undefined, graph);
    const started = await first.run('start', { runId: 'run-graph' });
    await first.close();
    assert.deepEqual([started.status, started.wait], ['waiting', { token: 'call:root.nodes.Y:0#0', kind: 'input', member: 'Y' }]);
    assert.equal(resumeHint(started), "waiting: agent-plexus resume run-graph --input <text> --wait 'call:root.nodes.Y:0#0'");

    const second = await open(dir, file, { X: { ask: true }, Y: { ask: true } }, calls, undefined, graph);
    try {
      const resumed = await second.resume('run-graph', { input: 'for Y', wait: started.wait!.token });
      assert.deepEqual([resumed.status, resumed.output], ['completed', 'task-Y: for Y'], JSON.stringify(resumed.reason));
      assert.deepEqual(calls, ['invoke:X', 'invoke:Y', 'resume:Y']);
    } finally {
      await second.close();
    }
  }));

test('a member wait and a gate ask in parallel: the hint asks for what the kept wait needs, and each reply answers its wait', () =>
  inTempDir(async (dir) => {
    const file = join(dir, 'runs.db');
    const calls: string[] = [];
    const parallel: TopologySpec = { kind: 'parallel', branches: ['asker', 'billing'] };
    const members = { asker: { ask: true }, billing: {} };
    const first = await open(dir, file, members, calls, askingHost(), parallel);
    const started = await first.run('start', { runId: 'run-par' });
    await first.close();
    assert.deepEqual([started.status, started.reason?.layer, started.wait?.kind, started.wait?.member], ['waiting', 'member', 'input', 'asker']);
    assert.match(resumeHint(started), /--input <text> --wait 'call:root\.branches\[0\]:0#0'$/);

    const second = await open(dir, file, members, calls, askingHost(), parallel);
    try {
      const next = await second.resume('run-par', { input: 'order 42', wait: started.wait!.token });
      assert.deepEqual([next.status, next.reason?.layer, next.wait?.kind, next.wait?.member], ['waiting', 'host', 'approval', 'billing'], JSON.stringify(next.reason));
      assert.match(resumeHint(next), /--approve \| --deny --wait 'call:root\.branches\[1\]:0#0'$/);
      const stale = await second.resume('run-par', { input: 'order 42', wait: started.wait!.token });
      assert.equal(stale.reason?.detail, 'run run-par waits on another step');
      const done = await second.resume('run-par', { approved: true, wait: next.wait!.token });
      assert.equal(done.status, 'completed', JSON.stringify(done.reason));
      assert.deepEqual(calls.filter((c) => c.startsWith('resume:')), ['resume:asker']);
    } finally {
      await second.close();
    }
  }));

test('SIGINT stops a run in another agent-plexus process: exit 130, the run stopped aborted, the sqlite journal no longer holding it', { skip: process.platform === 'win32' }, () =>
  inTempDir(async (dir) => {
    const file = join(dir, 'runs.db');
    const marker = join(dir, 'in-flight');
    const config = join(dir, 'plexus.json');
    await writeFile(config, JSON.stringify({
      system: { name: 'slow' },
      members: { slow: { adapter: fileURLToPath(new URL('fixtures/slow-member.ts', import.meta.url)), options: { marker } } },
      ports: { topology: { adapter: 'basic-topology' }, execution: { adapter: 'sqlite-execution', options: { path: file } }, attribution: { adapter: 'rule-attribution' } },
      topology: { kind: 'sequence', steps: ['slow'] },
    }));
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const child = spawn(process.execPath, ['--conditions=@agent-plexus/source', '--disable-warning=ExperimentalWarning', cli, 'run', '--config', config, '--run-id', 'r-int', '--json', 'go'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    const closed = new Promise<number | null>((done) => child.on('close', (code) => done(code)));
    // The member is in flight once it wrote the marker; the signal comes then, as a Ctrl-C would.
    const until = Date.now() + 20_000;
    while (!existsSync(marker) && child.exitCode === null && Date.now() < until) await new Promise((wake) => setTimeout(wake, 20));
    assert.ok(existsSync(marker), `the member was not called:\n${stderr}`);
    child.kill('SIGINT');
    assert.equal(await closed, 130, stderr);
    const result = JSON.parse(stdout) as { status: string; reason?: { code: string }; runId: string };
    assert.deepEqual([result.status, result.reason?.code, result.runId], ['stopped', 'aborted', 'r-int']);
    const row = rowOf(file, 'r-int');
    assert.deepEqual([row?.status, row?.lease], ['stopped', null]);
    // Nothing holds the run: a cancel is refused because the run is over, not because another invocation has it.
    const cancelled = captureIo(dir);
    assert.equal(await main(['cancel', 'r-int', '--config', config, '--json'], cancelled.io), 1);
    assert.equal(JSON.parse(cancelled.out()).reason.code, 'conflict');
  }));
