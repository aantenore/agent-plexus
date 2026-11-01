import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assemble, loadConfig, prototypeHost, type System } from '@agent-plexus/core';

const CONFIG = fileURLToPath(new URL('../plexus.json', import.meta.url));

async function system(profile?: string): Promise<System> {
  const config = await loadConfig(CONFIG, profile ? { profile } : {});
  return assemble(config, { host: prototypeHost({ quiet: true }) });
}

test('an invoice question is routed to billing', async () => {
  const s = await system();
  try {
    const result = await s.run('I need a refund for my last invoice');
    assert.equal(result.status, 'completed');
    assert.match(result.output, /^Billing:/);
    assert.deepEqual(result.record.map((h) => h.member), ['triage', 'billing']);
    assert.deepEqual(result.record.map((h) => h.node), ['root.steps[0]', 'root.steps[1]']);
  } finally {
    await s.close();
  }
});

test('a product question is routed to manuals', async () => {
  const s = await system();
  try {
    const result = await s.run('How do I do the product setup?');
    assert.equal(result.status, 'completed');
    assert.match(result.output, /^Manuals:/);
    assert.deepEqual(result.record.map((h) => h.member), ['triage', 'manuals']);
  } finally {
    await s.close();
  }
});

test('a request no rule matches falls back to triage', async () => {
  const s = await system();
  try {
    const result = await s.run('Hello there');
    assert.equal(result.status, 'completed');
    assert.match(result.output, /Hello there/);
    assert.deepEqual(result.record.map((h) => h.node), ['root.steps[0]', 'root.steps[1]', 'root.steps[1].fallback']);
    assert.equal(result.record[1]?.reason?.layer, 'routing');
  } finally {
    await s.close();
  }
});

test('the crash input stops billing and attribution names layer member, member billing', async () => {
  const s = await system();
  try {
    const result = await s.run('My invoice page will crash when I ask for a refund');
    assert.equal(result.status, 'stopped');
    assert.equal(result.reason?.code, 'error');
    const billing = result.record.find((h) => h.member === 'billing');
    assert.equal(billing?.status, 'stopped');
    const [attribution] = await s.attribute(result);
    assert.equal(attribution?.layer, 'member');
    assert.equal(attribution?.member, 'billing');
    assert.equal(attribution?.hopId, billing?.hopId);
  } finally {
    await s.close();
  }
});

test('the production profile is refused on the prototype host and adapter', async () => {
  const s = await system('production');
  try {
    const failures = (await s.check()).filter((f) => f.severity === 'fail').map((f) => f.path);
    assert.deepEqual(failures.sort(), ['$.host', '$.ports.execution']);
  } finally {
    await s.close();
  }
});
