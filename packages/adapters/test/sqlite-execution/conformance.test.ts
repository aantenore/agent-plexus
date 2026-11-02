import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAdapter } from '@agent-plexus/conformance';
import { adapter, createSqliteExecution } from '../../src/sqlite-execution/index.ts';

test('sqlite-execution passes ExecutionPort conformance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sqlite-execution-conformance-'));
  try {
    const path = join(dir, 'journal.db');
    // Each instance on the same file stands for another process: durable, exclusive across instances.
    const open = () => createSqliteExecution({ path }, { name: 'execution', cwd: dir });
    const report = await checkAdapter(adapter, {
      options: { path },
      fixtures: {
        reopen: open,
        secondInstance: open,
        exclusive: true,
        lease: { ms: 750, open: () => createSqliteExecution({ path: join(dir, 'lease.db'), leaseMs: 750 }, { name: 'execution', cwd: dir }) },
        alive: { module: new URL('../../src/sqlite-execution/index.ts', import.meta.url).href, options: { path: join(dir, 'alive.db') } },
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
