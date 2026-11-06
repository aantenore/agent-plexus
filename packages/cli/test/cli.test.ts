import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { SystemResult } from '@agent-plexus/core';
import { publicResult, resumeHint } from '../src/format.ts';
import { main } from '../src/main.ts';
import { captureIo, CASES, CONFIG, EXAMPLE } from './helpers.ts';

/** The example config with member modules made absolute, so it can live in another folder. */
async function variant(dir: string, change: (config: any) => void): Promise<string> {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  for (const member of Object.values<any>(config.members)) member.options.module = join(EXAMPLE, member.options.module);
  change(config);
  const file = join(dir, 'plexus.json');
  await writeFile(file, JSON.stringify(config));
  return file;
}

test('run prints the output on stdout and one line per hop on stderr', async () => {
  const c = captureIo();
  assert.equal(await main(['run', '--config', CONFIG, 'I need a refund for my invoice'], c.io), 0, c.err());
  assert.match(c.out(), /^Billing: refunds are issued/);
  assert.match(c.err(), /^triage completed \d+ms\nbilling completed \d+ms$/);
});

test('run joins unquoted words, and --quiet drops the hop lines', async () => {
  const c = captureIo();
  assert.equal(await main(['run', '--quiet', 'how', 'do', 'I', 'do', 'the', 'product', 'setup'], c.io), 0, c.err());
  assert.match(c.out(), /^Manuals: to set up the product/);
  assert.equal(c.err(), '');
});

test('run --json prints the result with keys in the record, never texts', async () => {
  const c = captureIo();
  assert.equal(await main(['run', '--json', 'refund my invoice'], c.io), 0, c.err());
  const result = JSON.parse(c.out());
  assert.equal(result.status, 'completed');
  assert.match(result.output, /^Billing:/);
  assert.deepEqual(result.record.map((h: { member: string }) => h.member), ['triage', 'billing']);
  assert.ok(result.record.every((h: Record<string, unknown>) => !('input' in h) && !('text' in h) && !('output' in h)));
});

test('publicResult strips reason.detail from the result and from every record entry', () => {
  const hop = { hopId: 'h', node: 'root', rootRunId: 'r', hops: 1, startedAt: '', durationMs: 1 };
  const result: SystemResult = {
    status: 'stopped', output: '', runId: 'r', reason: { code: 'denied', layer: 'host', by: 'x', detail: 'secret rule' },
    record: [
      { ...hop, hopId: 'a', member: 'triage', status: 'completed' },
      { ...hop, hopId: 'b', member: 'billing', status: 'stopped', reason: { code: 'guard_block', layer: 'host', stage: 'send', detail: 'secret match' } },
    ],
  };
  const printed = publicResult(result);
  assert.deepEqual(printed.reason, { code: 'denied', layer: 'host', by: 'x' });
  assert.deepEqual(printed.record[1]?.reason, { code: 'guard_block', layer: 'host', stage: 'send' });
  assert.equal(printed.record[0]?.reason, undefined);
  assert.doesNotMatch(JSON.stringify(printed), /secret/);
  assert.equal(result.record[1]?.reason?.detail, 'secret match');
});

test('resumeHint asks for what the kept wait needs and names it, quoted for the shell', () => {
  const waiting: SystemResult = { status: 'waiting', output: '', runId: 'r1', reason: { code: 'needs_input', layer: 'member' }, record: [] };
  assert.equal(resumeHint({ ...waiting, wait: { token: 'call:root.branches[1]:0#0', kind: 'approval', member: 'G' } }), "waiting: agent-plexus resume r1 --approve | --deny --wait 'call:root.branches[1]:0#0'");
  assert.equal(resumeHint({ ...waiting, runId: "it's", wait: { token: 'call:root:0#2', kind: 'input', member: 'D' } }), "waiting: agent-plexus resume 'it'\\''s' --input <text> --wait 'call:root:0#2'");
  assert.equal(resumeHint(waiting), 'waiting: agent-plexus resume r1 --input <text>');
  assert.equal(resumeHint({ ...waiting, reason: { code: 'needs_input', layer: 'host' } }), 'waiting: agent-plexus resume r1 --approve | --deny');
});

test('a run that does not complete exits 1 and names the stop code', async () => {
  const c = captureIo();
  assert.equal(await main(['run', 'invoice crash'], c.io), 1);
  assert.equal(c.out(), '[stopped] error');
  assert.match(c.err(), /billing stopped error \d+ms/);
});

test('check passes for the base config and for the prototype profile', async () => {
  for (const args of [['check'], ['check', '--profile', 'prototype']]) {
    const c = captureIo();
    assert.equal(await main(args, c.io), 0, c.out());
    assert.match(c.out(), /tier prototype\ncheck passed$/);
  }
});

test('check --profile production fails on the prototype host and adapter, without a stack trace', async () => {
  const c = captureIo();
  assert.equal(await main(['check', '--profile', 'production'], c.io), 1);
  assert.match(c.out(), /FAIL \$\.host: host "prototype" is a prototype host/);
  assert.match(c.out(), /FAIL \$\.ports\.execution: adapter "memory-execution" is prototype-only/);
  assert.match(c.out(), /check failed: 2 FAIL, 0 WARN$/);
  assert.equal(c.err(), '');
  assert.doesNotMatch(c.out(), /\bat .*\.ts:\d+/);
});

test('check reports an unreadable config, an unknown profile and an unloadable adapter as FAIL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-cli-'));
  try {
    await writeFile(join(dir, 'plexus.json'), '{ not json');
    const unreadable = captureIo(dir);
    assert.equal(await main(['check'], unreadable.io), 1);
    assert.match(unreadable.out(), /FAIL .*plexus\.json: cannot read as JSON/);

    const unknown = captureIo();
    assert.equal(await main(['check', '--profile', 'nope'], unknown.io), 1);
    assert.match(unknown.out(), /FAIL \$\.profiles\.nope: not defined/);

    await variant(dir, (config) => { config.ports.registry.adapter = 'does-not-exist'; });
    const adapter = captureIo(dir);
    assert.equal(await main(['check'], adapter.io), 1);
    assert.match(adapter.out(), /FAIL \$\.ports\.registry: adapter "does-not-exist" is not one of @agent-plexus\/adapters/);
    assert.equal(adapter.err(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check reports an invalid topology as FAIL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-cli-'));
  try {
    const file = await variant(dir, (config) => { config.topology = { kind: 'sequence', steps: ['triage', 'ghost'] }; });
    const c = captureIo(dir);
    assert.equal(await main(['check', '--config', file], c.io), 1);
    assert.match(c.out(), /FAIL \$\.topology: .*ghost/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check and run use the @agent-plexus/adapters installed next to the config, ahead of the copy next to the core', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-cli-'));
  try {
    // A project's own install of the adapters package: one adapter, which this checkout's copy does not have.
    const pkg = join(dir, 'node_modules', '@agent-plexus', 'adapters');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@agent-plexus/adapters', version: '0.0.0', type: 'module', exports: { './local-member': './local-member.mjs' } }));
    await writeFile(join(pkg, 'local-member.mjs'), `export const adapters = [{
      fills: 'MemberPort', name: 'local-member', maps: { technology: 'local' }, portVersion: '0.1.0', tiers: ['prototype'],
      create: (options, ctx) => ({
        name: ctx.name,
        describe: async () => ({ id: ctx.name, name: ctx.name, description: 'local', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: false } }),
        invoke: async () => ({ status: 'completed', output: 'from the local package' }),
      }),
    }];`);
    const adapters = join(EXAMPLE, '../../packages/adapters/src');
    const config = (member: string) => ({
      system: { name: 'local' },
      members: { m: { adapter: member } },
      ports: {
        topology: { adapter: join(adapters, 'basic-topology/index.ts') },
        execution: { adapter: join(adapters, 'memory-execution/index.ts') },
        attribution: { adapter: join(adapters, 'rule-attribution/index.ts') },
      },
      topology: { kind: 'sequence', steps: ['m'] },
    });
    await writeFile(join(dir, 'plexus.json'), JSON.stringify(config('local-member')));
    const checked = captureIo(dir);
    assert.equal(await main(['check'], checked.io), 0, checked.out());
    const ran = captureIo(dir);
    assert.equal(await main(['run', '--quiet', 'hi'], ran.io), 0, ran.err());
    assert.equal(ran.out(), 'from the local package');
    // A name the local package does not export is not looked up next to the core.
    await writeFile(join(dir, 'other.json'), JSON.stringify(config('function-member')));
    const other = captureIo(dir);
    assert.equal(await main(['check', '--config', 'other.json'], other.io), 1);
    assert.match(other.out(), /FAIL \$\.members\.m: adapter "function-member" is not one of @agent-plexus\/adapters/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eval passes two cases, fails and attributes the crash, and exits 1', async () => {
  const c = captureIo();
  assert.equal(await main(['eval', CASES], c.io), 1, c.err());
  assert.match(c.out(), /^PASS billing-refund$/m);
  assert.match(c.out(), /^PASS product-setup$/m);
  assert.match(c.out(), /^FAIL billing-crash$/m);
  assert.match(c.out(), /^ {2}attribution member billing 0\.60 code:error/m);
  assert.match(c.out(), /eval: 2 passed, 1 failed$/);
});

test('eval --json is machine output', async () => {
  const c = captureIo();
  assert.equal(await main(['eval', '--json', CASES], c.io), 1);
  const report = JSON.parse(c.out());
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 1);
  const crash = report.cases.find((x: { id: string }) => x.id === 'billing-crash');
  assert.equal(crash.passed, false);
  assert.equal(crash.status, 'stopped');
  assert.equal(crash.attributions[0].layer, 'member');
  assert.equal(crash.attributions[0].member, 'billing');
  assert.deepEqual(report.cases.filter((x: { passed: boolean }) => x.passed).map((x: { attributions: unknown[] }) => x.attributions), [[], []]);
});

test('eval exits 0 when every case passes, and rejects a malformed cases file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-cli-'));
  try {
    await writeFile(join(dir, 'ok.json'), JSON.stringify([{ id: 'plain', input: 'refund my invoice' }]));
    const ok = captureIo();
    assert.equal(await main(['eval', join(dir, 'ok.json')], ok.io), 0, ok.out());
    assert.match(ok.out(), /eval: 1 passed, 0 failed$/);

    await writeFile(join(dir, 'bad.json'), JSON.stringify({ id: 'x' }));
    const bad = captureIo();
    assert.equal(await main(['eval', join(dir, 'bad.json')], bad.io), 1);
    assert.match(bad.err(), /expected an array of cases/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eval scores a member contains expectation against the stored output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-cli-'));
  try {
    const member = (contains: string) => ({ id: contains, input: 'refund my invoice', expected: { members: { billing: { contains } } } });
    await writeFile(join(dir, 'cases.json'), JSON.stringify([member('refunds are issued'), member('no such text')]));
    const c = captureIo();
    assert.equal(await main(['eval', '--json', join(dir, 'cases.json')], c.io), 1, c.err());
    const [hit, miss] = JSON.parse(c.out()).cases;
    assert.deepEqual(hit.scores.map((x: { value: number }) => x.value), [1]);
    assert.equal(hit.passed, true);
    assert.deepEqual(miss.scores.map((x: { value: number }) => x.value), [0]);
    assert.match(miss.scores[0].reason, /contains/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dev runs each line and stops at /exit', async () => {
  const c = captureIo(undefined, 'refund my invoice\n\nhow do I do the product setup\n/exit\nignored\n');
  assert.equal(await main(['dev'], c.io), 0, c.err());
  assert.deepEqual(c.out().split('\n').map((l) => l.split(':')[0]), ['Billing', 'Manuals']);
  assert.match(c.err(), /^system support .*\/exit to quit\.\ntriage completed/);
  assert.equal(c.err().match(/^billing completed/gm)?.length, 1);
  assert.equal(c.err().match(/^manuals completed/gm)?.length, 1);
});

test('--help per command exits 0; wrong usage and unknown commands exit 2', async () => {
  for (const name of ['init', 'check', 'run', 'resume', 'cancel', 'dev', 'eval']) {
    const c = captureIo();
    assert.equal(await main([name, '--help'], c.io), 0);
    assert.match(c.out(), new RegExp(`^agent-plexus ${name}`));
  }
  const noText = captureIo();
  assert.equal(await main(['run'], noText.io), 2);
  assert.match(noText.err(), /expected <text>\nusage: agent-plexus run/);
  const badFlag = captureIo();
  assert.equal(await main(['check', '--json'], badFlag.io), 2);
  const unknown = captureIo();
  assert.equal(await main(['frobnicate'], unknown.io), 2);
  assert.match(unknown.err(), /unknown command "frobnicate"[\s\S]*agent-plexus <command>/);
  const none = captureIo();
  assert.equal(await main([], none.io), 0);
  assert.match(none.out(), /^agent-plexus <command>/);
});

test('a folder without plexus.json is a usage error that names the path and points to init and --config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-noconfig-'));
  try {
    for (const command of [['check'], ['run', 'hello']]) {
      const c = captureIo(dir);
      assert.equal(await main(command, c.io), 2);
      const message = `no config at ${join(dir, 'plexus.json')}: run \`agent-plexus init\` to create a starter, or pass --config <file>`;
      assert.ok(c.err().startsWith(`agent-plexus ${command[0]}: ${message}\nusage: `), c.err());
      assert.doesNotMatch(c.err(), /ENOENT/);
      assert.equal(c.out(), '');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A system whose one member waits for input, over the example file journal in `dir`, so runs outlive the process. */
async function waitingSystem(dir: string): Promise<string> {
  const file = join(dir, 'plexus.json');
  await writeFile(file, JSON.stringify({
    system: { name: 'asking' },
    members: { asker: { adapter: fileURLToPath(new URL('fixtures/asking-member.ts', import.meta.url)) } },
    ports: {
      topology: { adapter: 'basic-topology' },
      execution: { adapter: join(EXAMPLE, '../swap/adapters/file-execution.ts'), options: { dir: join(dir, 'journal') } },
      attribution: { adapter: 'rule-attribution' },
    },
    topology: { kind: 'sequence', steps: ['asker'] },
  }));
  return file;
}

test('resume answers a waiting run from another process through a durable journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-cli-'));
  try {
    const file = await waitingSystem(dir);
    const started = captureIo();
    assert.equal(await main(['run', '--config', file, 'start'], started.io), 3);
    assert.equal(started.out(), '[waiting] needs_input member');
    const hint = /waiting: agent-plexus resume (\S+) --input <text> --wait '([^']+)'/.exec(started.err());
    assert.ok(hint, started.err());
    const [, runId, wait] = hint as unknown as [string, string, string];
    assert.equal(wait, 'call:root.steps[0]:0#0');

    const elsewhere = captureIo();
    assert.equal(await main(['resume', runId, '--config', file, '--json', '--input', 'x', '--wait', 'call:other:0#0'], elsewhere.io), 1);
    assert.equal(JSON.parse(elsewhere.out()).status, 'failed');

    const resumed = captureIo();
    assert.equal(await main(['resume', runId, '--config', file, '--input', 'order 42', '--wait', wait], resumed.io), 0, resumed.err());
    assert.equal(resumed.out(), 'task-1: order 42');
    assert.match(resumed.err(), /^asker completed \d+ms$/);

    const again = captureIo();
    assert.equal(await main(['resume', runId, '--config', file, '--json', '--approve'], again.io), 1);
    const result = JSON.parse(again.out());
    assert.deepEqual([result.status, result.reason], ['failed', { code: 'error', layer: 'execution' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel closes a waiting run from another process; the run is then neither resumed nor cancelled twice as new', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-cli-'));
  try {
    const file = await waitingSystem(dir);
    const started = captureIo();
    assert.equal(await main(['run', '--config', file, '--run-id', 'order-7', 'start'], started.io), 3);

    const cancelled = captureIo();
    assert.equal(await main(['cancel', 'order-7', '--config', file, '--reason', 'config changed'], cancelled.io), 0, cancelled.err());
    assert.equal(cancelled.out(), 'cancelled order-7');

    const resumed = captureIo();
    assert.equal(await main(['resume', 'order-7', '--config', file, '--json', '--input', 'x'], resumed.io), 1);
    assert.deepEqual(JSON.parse(resumed.out()).reason, { code: 'error', layer: 'execution' });

    const unknown = captureIo();
    assert.equal(await main(['cancel', 'nope', '--config', file, '--json'], unknown.io), 1);
    assert.deepEqual(JSON.parse(unknown.out()).reason, { code: 'not_found', layer: 'execution' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel needs exactly one run id', async () => {
  for (const args of [['cancel'], ['cancel', 'a', 'b']]) {
    const c = captureIo();
    assert.equal(await main(args, c.io), 2, args.join(' '));
    assert.match(c.err(), /usage: agent-plexus cancel/);
  }
});

test('resume needs one run id and exactly one of --input, --approve, --deny', async () => {
  for (const args of [['resume', '--approve'], ['resume', 'r1'], ['resume', 'r1', '--approve', '--deny'], ['resume', 'r1', '--input', 'x', '--reason', 'y'], ['resume', 'r1', '--approve', '--wait', '']]) {
    const c = captureIo();
    assert.equal(await main(args, c.io), 2, args.join(' '));
    assert.match(c.err(), /usage: agent-plexus resume/);
  }
});

test('run --run-id runs under the given id; a waiting run exits 3 and its resume hint names that id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-cli-'));
  try {
    const file = await waitingSystem(dir);
    const started = captureIo();
    assert.equal(await main(['run', '--config', file, '--run-id', 'order-42', '--json', 'start'], started.io), 3);
    const result = JSON.parse(started.out());
    assert.deepEqual([result.status, result.runId], ['waiting', 'order-42']);
    const resumed = captureIo();
    assert.equal(await main(['resume', 'order-42', '--config', file, '--input', 'x', '--wait', result.wait.token], resumed.io), 0, resumed.err());
    for (const bad of [['run', '--run-id', '', 'x'], ['run', '--run-id', 'r'.repeat(129), 'x']]) {
      const c = captureIo();
      assert.equal(await main(bad, c.io), 2);
      assert.match(c.err(), /--run-id needs an id of 1 to 128 characters/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--version, -v and version print the version of the package and exit 0', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.match(version, /^\d+\.\d+\.\d+/);
  for (const arg of ['--version', '-v', 'version']) {
    const c = captureIo();
    assert.equal(await main([arg], c.io), 0);
    assert.equal(c.out(), version);
    assert.equal(c.err(), '');
  }
  const top = captureIo();
  await main(['--help'], top.io);
  assert.match(top.out(), /--version/);
  assert.match(top.out(), /130 interrupted/);
});

test('help documents exit code 3 for a waiting run and names no adapter', async () => {
  const top = captureIo();
  await main(['--help'], top.io);
  assert.match(top.out(), /3 a run waiting for a reply/);
  for (const name of ['run', 'resume']) {
    const c = captureIo();
    await main([name, '--help'], c.io);
    assert.match(c.out(), /3 when it waits|3 waiting/);
    assert.doesNotMatch(c.out(), /memory-execution|sqlite-execution/);
  }
});

/** An empty project folder whose `node_modules` is the repository's, so the starter's members find the packages. */
async function emptyProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-init-'));
  await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(dir, 'node_modules'), 'dir');
  return dir;
}

test('init writes the starter into an empty folder; check passes and eval attributes the crash case to billing', async () => {
  const dir = await emptyProject();
  try {
    const c = captureIo(dir);
    assert.equal(await main(['init'], c.io), 0, c.err());
    assert.deepEqual((await readdir(dir)).sort(), ['README.md', 'cases.json', 'members', 'node_modules', 'package.json', 'plexus.json']);
    assert.equal(await readFile(join(dir, 'plexus.json'), 'utf8'), await readFile(CONFIG, 'utf8'));
    assert.equal(await readFile(join(dir, 'members', 'billing.ts'), 'utf8'), await readFile(join(EXAMPLE, 'members', 'billing.ts'), 'utf8'));
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.deepEqual(Object.keys(pkg.devDependencies), ['@agent-plexus/adapters', '@agent-plexus/cli', '@agent-plexus/core']);
    assert.match(c.out(), /next:\n  npm install\n  npx agent-plexus check\n/);

    const check = captureIo(dir);
    assert.equal(await main(['check'], check.io), 0, check.out());
    assert.match(check.out(), /check passed$/);
    const ev = captureIo(dir);
    assert.equal(await main(['eval', 'cases.json'], ev.io), 1, ev.err());
    assert.match(ev.out(), /FAIL billing-crash[\s\S]*attribution member billing [\s\S]*eval: 2 passed, 1 failed$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('init sets "type": "module" in an existing package.json and creates a missing folder', async () => {
  const dir = await emptyProject();
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs', devDependencies: { '@agent-plexus/cli': '^0.2.0' } }));
    const c = captureIo(dir);
    assert.equal(await main(['init', 'sub/system'], c.io), 0, c.err());
    assert.match(c.out(), /next:\n  cd sub\/system\n  npm install\n/);
    const top = captureIo(dir);
    assert.equal(await main(['init', '--force'], top.io), 0, top.err());
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.match(top.out(), /"type": "module", was "commonjs"/);
    assert.match(top.out(), /npm install --save-dev @agent-plexus\/adapters @agent-plexus\/core\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('init refuses a folder with other files (exit 1) unless --force, and takes at most one folder', async () => {
  const dir = await emptyProject();
  try {
    await writeFile(join(dir, 'notes.txt'), 'mine');
    const c = captureIo(dir);
    assert.equal(await main(['init'], c.io), 1);
    assert.match(c.err(), /is not empty \(notes\.txt\); use --force/);
    assert.deepEqual((await readdir(dir)).sort(), ['node_modules', 'notes.txt']);
    const forced = captureIo(dir);
    assert.equal(await main(['init', '--force'], forced.io), 0, forced.err());
    assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'mine');
    const two = captureIo(dir);
    assert.equal(await main(['init', 'a', 'b'], two.io), 2);
    assert.match(two.err(), /expected at most one \[dir\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every command of the help is in the package README and the package description', async () => {
  const top = captureIo();
  await main(['--help'], top.io);
  const names = [...top.out().matchAll(/^  ([a-z]+) /gm)].map((m) => m[1]);
  assert.ok(names.length >= 7, names.join(','));
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const { description } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { description: string };
  for (const name of names) {
    assert.match(readme, new RegExp(`^\\| \`${name}[\` ]`, 'm'), `README.md has no row for ${name}`);
    assert.match(description, new RegExp(`\\b${name}\\b`), `the description does not name ${name}`);
  }
});
