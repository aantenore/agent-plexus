import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MemberCallContext, MemberResult } from '@agent-plexus/core';
import { adapter, createFunctionMember, toMemberResult } from '../src/index.ts';

const cwd = dirname(fileURLToPath(import.meta.url));

const callCtx = (extra: Partial<MemberCallContext> = {}): MemberCallContext => ({
  runId: 'r1',
  system: 's',
  hopId: 'h1',
  outbound: { remainingMs: 1000, hops: 0, maxHops: 3, rootRunId: 'r1', parentRunId: 'r1' },
  checkpoint: async () => {},
  ...extra,
});

test('adapter descriptor', () => {
  assert.equal(adapter.fills, 'MemberPort');
  assert.deepEqual(adapter.tiers, ['prototype', 'production']);
  assert.deepEqual(adapter.maps, { technology: 'in-process function' });
});

test('describe builds an entry with a skill made from tags', async () => {
  const member = await createFunctionMember({ fn: () => 'x', description: 'd', tags: ['billing'], attrs: { region: 'eu' }, audience: 'aud' }, { name: 'triage', cwd });
  const entry = await member.describe();
  assert.equal(entry.id, 'triage');
  assert.equal(entry.name, 'triage');
  assert.equal(entry.description, 'd');
  assert.deepEqual(entry.endpoint, { protocol: 'function' });
  assert.deepEqual(entry.trust, { signed: false, pinned: true });
  assert.deepEqual(entry.skills.map((s) => s.tags), [['billing']]);
  assert.equal(entry.audience, 'aud');
  assert.deepEqual(entry.attrs, { region: 'eu' });
});

test('describe prefers explicit skills and fills their defaults', async () => {
  const member = await createFunctionMember({ fn: () => 'x', name: 'Triage', tags: ['ignored'], skills: [{ id: 'refund', tags: ['money'] }] }, { name: 'triage', cwd });
  const entry = await member.describe();
  assert.equal(entry.name, 'Triage');
  assert.deepEqual(entry.skills, [{ id: 'refund', name: 'refund', description: '', tags: ['money'] }]);
});

test('no skills and no tags gives no skills; a prototype-key id is kept', async () => {
  const member = await createFunctionMember({ fn: () => 'x' }, { name: 'constructor', cwd });
  const entry = await member.describe();
  assert.equal(entry.id, 'constructor');
  assert.equal(member.name, 'constructor');
  assert.deepEqual(entry.skills, []);
});

test('a returned string completes; the function receives input and context', async () => {
  let seen: unknown[] = [];
  const member = await createFunctionMember({ fn: (input, ctx) => { seen = [input, ctx.hopId]; return 'done'; } }, { name: 'm', cwd });
  assert.deepEqual(await member.invoke('hi', callCtx()), { status: 'completed', output: 'done' });
  assert.deepEqual(seen, ['hi', 'h1']);
});

test('an async MemberResult passes through', async () => {
  const result: MemberResult = { status: 'completed', output: 'ok', usage: { inputTokens: 1, outputTokens: 2 }, ext: { 'a.b': 1 } };
  const member = await createFunctionMember({ fn: async () => result }, { name: 'm', cwd });
  assert.deepEqual(await member.invoke({ text: 'hi' }, callCtx()), result);
});

test('a non-completed result without reason gets reason error; with reason it is kept', async () => {
  assert.deepEqual(toMemberResult({ status: 'failed', output: '' }), { status: 'failed', output: '', reason: { code: 'error' } });
  const kept = { status: 'stopped' as const, output: '', reason: { code: 'rejected' } };
  assert.deepEqual(toMemberResult(kept), kept);
});

test('invalid results are refused', () => {
  assert.throws(() => toMemberResult({ status: 'done', output: '' }), TypeError);
  assert.throws(() => toMemberResult({ status: 'completed', output: 1 }), TypeError);
  assert.throws(() => toMemberResult(null), TypeError);
  assert.throws(() => toMemberResult(['x']), TypeError);
  assert.throws(() => toMemberResult(undefined), TypeError);
});

test('an invalid result from the function rejects the call', async () => {
  const member = await createFunctionMember({ fn: () => ({ status: 'completed' }) as unknown as MemberResult }, { name: 'm', cwd });
  await assert.rejects(member.invoke('x', callCtx()), TypeError);
});

test('errors thrown by the function propagate', async () => {
  const sync = await createFunctionMember({ fn: () => { throw new Error('boom'); } }, { name: 'm', cwd });
  await assert.rejects(sync.invoke('x', callCtx()), /boom/);
  const asyncFn = await createFunctionMember({ fn: async () => { throw new Error('late'); } }, { name: 'm', cwd });
  await assert.rejects(asyncFn.invoke('x', callCtx()), /late/);
});

test('an already aborted signal stops without calling the function', async () => {
  let called = false;
  const member = await createFunctionMember({ fn: () => { called = true; return 'x'; } }, { name: 'm', cwd });
  const result = await member.invoke('x', callCtx({ signal: AbortSignal.abort() }));
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason?.code, 'aborted');
  assert.equal(called, false);
});

test('abort during the call stops the member', async () => {
  const controller = new AbortController();
  const member = await createFunctionMember({ fn: () => new Promise<string>(() => {}) }, { name: 'm', cwd });
  const pending = member.invoke('x', callCtx({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 5);
  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason?.code, 'aborted');
});

test('a late failure after an abort does not leak', async () => {
  const controller = new AbortController();
  const member = await createFunctionMember({ fn: () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 20)) }, { name: 'm', cwd });
  const pending = member.invoke('x', callCtx({ signal: controller.signal }));
  controller.abort();
  assert.equal((await pending).reason?.code, 'aborted');
  await new Promise((r) => setTimeout(r, 40));
});

test('a signal that never fires is detached after the call', async () => {
  const controller = new AbortController();
  const member = await createFunctionMember({ fn: () => 'ok' }, { name: 'm', cwd });
  assert.equal((await member.invoke('x', callCtx({ signal: controller.signal }))).output, 'ok');
  controller.abort();
});

test('module loads a named export relative to cwd; the entry carries the reference', async () => {
  const member = await createFunctionMember({ module: './fixtures/members.ts#answer' }, { name: 'm', cwd });
  assert.equal((await member.invoke('hi', callCtx())).output, 'echo:hi');
  assert.deepEqual((await member.describe()).endpoint, { protocol: 'function', ref: './fixtures/members.ts#answer' });
});

test('module without an export name uses the default export', async () => {
  const member = await createFunctionMember({ module: './fixtures/members.ts' }, { name: 'm', cwd });
  assert.equal((await member.invoke('hi', callCtx())).output, 'default-export');
});

test('invalid options fail at create time', async () => {
  await assert.rejects(createFunctionMember({}, { name: 'm', cwd }), /module or fn/);
  await assert.rejects(createFunctionMember({ module: './fixtures/members.ts#missing' }, { name: 'm', cwd }), /not a function/);
  await assert.rejects(createFunctionMember({ module: './fixtures/members.ts#notAFunction' }, { name: 'm', cwd }), /not a function/);
  await assert.rejects(createFunctionMember({ module: './fixtures/members.ts#toString' }, { name: 'm', cwd }), /not a function/);
  await assert.rejects(createFunctionMember({ module: './fixtures/members.ts#' }, { name: 'm', cwd }), /<path>#<export>/);
  await assert.rejects(createFunctionMember({ module: '#answer' }, { name: 'm', cwd }), /<path>#<export>/);
  await assert.rejects(createFunctionMember({ module: './nope.ts#x' }, { name: 'm', cwd }));
  await assert.rejects(createFunctionMember({ fn: 'x' as never }, { name: 'm', cwd }), /fn must be a function/);
});
