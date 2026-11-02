import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adapter as basicTopology } from '@agent-plexus/adapters/basic-topology';
import { adapter as memoryExecution } from '@agent-plexus/adapters/memory-execution';
import { adapter as ruleAttribution } from '@agent-plexus/adapters/rule-attribution';
import { checkAdapter, checkSystem, type AnyDescriptor, type SystemFixtures } from '@agent-plexus/conformance';
import { adapter as fileExecution, createFileExecution } from '../adapters/file-execution.ts';
import { adapter as fileRegistry } from '../adapters/file-registry.ts';
import { adapter as keywordRouter } from '../adapters/keyword-router.ts';
import { adapter as lastFailure } from '../adapters/last-failure-attribution.ts';
import { adapter as linearTopology } from '../adapters/linear-topology.ts';
import { adapter as tableMember } from '../adapters/table-member.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('file-execution passes ExecutionPort conformance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'file-execution-conformance-'));
  try {
    // Durable: a new instance on the directory resumes the runs. Not exclusive: no hold across processes.
    const report = await checkAdapter(fileExecution, {
      options: { dir },
      fixtures: {
        reopen: () => createFileExecution({ dir }, { name: 'execution', cwd: dir }),
        alive: { module: new URL('../adapters/file-execution.ts', import.meta.url).href, options: { dir: join(dir, 'alive') } },
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file-registry passes RegistryPort conformance', async () => {
  const report = await checkAdapter(fileRegistry, { options: { file: './registry.json' }, ctx: { cwd: root }, fixtures: { ids: ['billing', 'manuals'] } });
  assert.deepEqual(report.failures, []);
});

test('keyword-router passes AgentRouterPort conformance', async () => {
  const report = await checkAdapter(keywordRouter, { fixtures: { cases: [{ input: 'refund of my invoice', expect: 'billing' }] } });
  assert.deepEqual(report.failures, []);
});

test('linear-topology passes TopologyPort conformance for sequence and route', async () => {
  const report = await checkAdapter(linearTopology);
  assert.deepEqual(report.failures, []);
});

test('last-failure-attribution passes AttributionPort conformance', async () => {
  const report = await checkAdapter(lastFailure);
  assert.deepEqual(report.failures, []);
});

test('table-member passes MemberPort conformance', async () => {
  const report = await checkAdapter(tableMember, {
    options: { table: './members/billing.table.json', description: 'Answers invoice, refund and charge questions' },
    ctx: { cwd: root },
    fixtures: { inputs: ['refund please', 'it will crash', 'hello'] },
  });
  assert.deepEqual(report.failures, []);
});

test('the swap adapters work inside an assembled system (run, wait, resume, parallel)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swap-system-conformance-'));
  try {
    const adapters = [basicTopology, memoryExecution, ruleAttribution];
    const subjects: [AnyDescriptor, Omit<SystemFixtures, 'adapters'>][] = [
      [fileExecution, { options: { dir }, durable: true }],
      [linearTopology, {}],
      [lastFailure, {}],
      [tableMember, { options: { table: './members/billing.table.json' }, cwd: root, input: 'refund please' }],
    ];
    for (const [descriptor, fixtures] of subjects) {
      const report = await checkSystem(descriptor, { adapters, ...fixtures });
      assert.deepEqual(report.failures, [], descriptor.name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
