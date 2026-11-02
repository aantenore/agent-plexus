import { isDeepStrictEqual } from 'node:util';
import type { MemberCallContext, MemberPort, MemberResult, RunInput } from '@agent-plexus/core';
import { Checks, extWarnings, settle, sleep } from '../check.ts';
import { entryProblems, resultProblems } from '../shapes.ts';

/** The credential the suite hands a member: it must never come back in a result. */
export const CANARY_CREDENTIAL = 'conformance-canary-credential-7f3a9c';

export interface MemberFixtures {
  /** Inputs the member answers; default `["hello"]`. */
  inputs?: RunInput[];
  /** An input that makes the member wait (`needs_input` or `needs_auth`). */
  wait?: RunInput;
  /** What answers that wait through `resume`; default `"more"`. */
  reply?: RunInput;
  /** An input the member works on long enough to be aborted while it runs. */
  slow?: RunInput;
  /** An input that makes the member checkpoint remote work before it answers. */
  checkpoint?: RunInput;
  /** How soon an aborted call must return, and a cancel settle once its signal fired (default 2000 ms). */
  promptMs?: number;
  /** Fields added to every call context (a caller, a session). */
  ctx?: Partial<MemberCallContext>;
}

const MAX_TASK_REF = 1024;
const STATUSES_WAITING = ['needs_input', 'needs_auth'];

interface Call { ctx: MemberCallContext; checkpoints: string[] }

function callContext(f: MemberFixtures, signal?: AbortSignal): Call {
  const checkpoints: string[] = [];
  const ctx: MemberCallContext = {
    runId: 'conformance-run',
    system: 'conformance',
    hopId: `conformance-hop-${Math.random().toString(36).slice(2)}`,
    credential: CANARY_CREDENTIAL,
    outbound: { remainingMs: 60_000, hops: 0, maxHops: 3, rootRunId: 'conformance-run', parentRunId: 'conformance-run' },
    checkpoint: async (ref: string) => { checkpoints.push(ref); },
    ...f.ctx,
    ...(signal ? { signal } : {}),
  };
  return { ctx, checkpoints };
}

/** Runs the MemberPort rules M1-M10 against an instance. */
export async function checkMember(port: MemberPort, f: MemberFixtures = {}, c = new Checks()): Promise<Checks> {
  if (!c.expect('M1', typeof port?.describe === 'function' && typeof port.invoke === 'function', 'describe and invoke must be functions')) return c;
  const promptMs = f.promptMs ?? 2000;
  const observed = { checkpoints: [] as string[], waited: false };
  const handles: string[] = [];

  /** The rules every result keeps: shape (M2), waiting (M6), no credential (M4), usage and cost (M8), its own layer (M10). */
  const inspect = (label: string, result: MemberResult | undefined, call: Call): void => {
    if (result === undefined) return;
    for (const p of resultProblems(result)) c.fail(/usage|costUsd/.test(p) ? 'M8' : 'M2', `${label}: ${p}`);
    for (const w of extWarnings(result.ext)) c.warn('M2', `${label}: ${w}`);
    c.rule('M8');
    const layer = result.reason?.layer;
    c.expect('M10', layer === undefined || layer === 'member', `${label}: reason.layer must be "member" when set, got ${JSON.stringify(layer)}; a member's own layer name goes in reason.memberLayer`);
    c.expect('M4', !JSON.stringify(result).includes(CANARY_CREDENTIAL), `${label}: the call's credential must never appear in the result`);
    for (const ref of call.checkpoints) {
      c.expect('M5', typeof ref === 'string' && ref.length > 0 && ref.length <= MAX_TASK_REF, `${label}: a checkpointed taskRef must be a non-empty string of at most ${MAX_TASK_REF} characters`);
      observed.checkpoints.push(ref);
      handles.push(ref);
    }
    if (result.status === 'waiting') {
      observed.waited = true;
      c.expect('M6', STATUSES_WAITING.includes(String(result.reason?.code)), `${label}: a waiting result needs code needs_input or needs_auth, got ${result.reason?.code}`);
      const handle = result.taskRef ?? call.checkpoints.at(-1);
      if (c.expect('M6', typeof handle === 'string' && handle.length > 0, `${label}: a waiting result needs a handle (taskRef, or a checkpoint)`)) handles.push(handle as string);
    }
  };

  const invoke = async (rule: string, label: string, input: RunInput, signal?: AbortSignal, timeoutMs?: number) => {
    const call = callContext(f, signal);
    const result = await c.attempt(rule, label, () => port.invoke(input, call.ctx), timeoutMs);
    inspect(label, result, call);
    return { result, call };
  };

  // M1: describe returns a valid entry, the same each time.
  const entry = await c.attempt('M1', 'describe', () => port.describe());
  if (entry !== undefined) {
    c.all('M1', entryProblems(entry), 'describe');
    const again = await c.attempt('M1', 'describe again', () => port.describe());
    c.expect('M1', isDeepStrictEqual(entry, again), 'describe must return the same entry each time');
    c.expect('M4', !JSON.stringify(entry).includes(CANARY_CREDENTIAL), 'describe must not carry a credential');
  }

  // M2: invoke returns a valid result.
  for (const [i, input] of (f.inputs ?? ['hello']).entries()) await invoke('M2', `invoke inputs[${i}]`, input);

  // M3: an aborted signal ends the call promptly, stopped with code aborted.
  const pre = new AbortController();
  pre.abort();
  const aborted = await invoke('M3', 'invoke with an aborted signal', (f.inputs ?? ['hello'])[0] ?? 'hello', pre.signal, promptMs);
  if (aborted.result) c.expect('M3', aborted.result.status === 'stopped' && aborted.result.reason?.code === 'aborted', `an aborted call must end stopped with code aborted, got ${aborted.result.status}/${aborted.result.reason?.code}`);
  if (f.slow === undefined) c.skip('M3', 'abort while the call runs: needs the slow fixture');
  else {
    const controller = new AbortController();
    const call = callContext(f, controller.signal);
    const running = settle(() => port.invoke(f.slow!, call.ctx), promptMs + 1000);
    await sleep(50);
    const at = Date.now();
    controller.abort();
    const out = await running;
    if ('error' in out) c.fail('M3', `invoke slow: ${out.timedOut ? 'did not return after its signal aborted' : `threw ${String(out.error)}`}`);
    else {
      inspect('invoke slow', out.value, call);
      c.expect('M3', Date.now() - at <= promptMs, `an aborted call must return within ${promptMs} ms of the abort, took ${Date.now() - at} ms`);
      c.expect('M3', out.value.status === 'stopped' && out.value.reason?.code === 'aborted', `a call aborted while it runs must end stopped with code aborted, got ${out.value.status}/${out.value.reason?.code}`);
    }
  }

  // M5: a member that checkpoints has resume; resume of a checkpointed handle continues the work.
  if (f.checkpoint !== undefined) {
    const { result, call } = await invoke('M5', 'invoke checkpoint', f.checkpoint);
    if (result) {
      c.expect('M5', call.checkpoints.length > 0, 'the checkpoint fixture must make the member checkpoint');
      const ref = call.checkpoints.at(-1);
      if (ref && typeof port.resume === 'function') {
        const next = callContext(f);
        const continued = await c.attempt('M5', 'resume a checkpointed handle', () => port.resume!(ref, undefined, next.ctx));
        inspect('resume checkpoint', continued, next);
      }
    }
  } else c.skip('M5', 'checkpoint: needs the checkpoint fixture');

  // M6: waiting has a code and a handle; resume answers it.
  if (f.wait !== undefined) {
    const { result, call } = await invoke('M6', 'invoke wait', f.wait);
    if (result) {
      c.expect('M6', result.status === 'waiting', `the wait fixture must make the member wait, got ${result.status}`);
      const handle = result.taskRef ?? call.checkpoints.at(-1);
      if (result.status === 'waiting' && handle && typeof port.resume === 'function') {
        const next = callContext(f);
        const answered = await c.attempt('M6', 'resume with a reply', () => port.resume!(handle, f.reply ?? 'more', next.ctx));
        inspect('resume reply', answered, next);
      } else if (result.status === 'waiting' && typeof port.resume !== 'function') c.skip('M6', 'resume of a waiting call: the member has no resume');
    }
  } else c.skip('M6', 'waiting: needs the wait fixture');

  // M5 (again): whoever checkpointed must be resumable.
  if (observed.checkpoints.length) c.expect('M5', typeof port.resume === 'function', 'a member that checkpoints must implement resume');

  // M7: cancel settles in time.
  if (typeof port.cancel !== 'function') c.skip('M7', 'cancel is not implemented');
  else if (!handles.length) c.skip('M7', 'cancel: needs a handle (the wait, checkpoint or slow fixture)');
  else {
    const ref = handles.at(-1)!;
    const call = callContext(f, AbortSignal.timeout(promptMs));
    const at = Date.now();
    const out = await settle(() => port.cancel!(ref, call.ctx), promptMs + 1000);
    c.expect('M7', !('timedOut' in out && out.timedOut), `cancel must settle once its signal fired (${promptMs} ms)`);
    c.expect('M7', Date.now() - at <= promptMs + 1000, `cancel took ${Date.now() - at} ms`);
  }

  // M9: the descriptor's capabilities match the instance.
  const capabilities = c.descriptor?.capabilities;
  if (!c.descriptor) c.skip('M9', 'capabilities: runs through checkAdapter only');
  else if (!capabilities) c.fail('M9', 'a MemberPort adapter must declare capabilities (resume, cancel, checkpoint, waits)');
  else {
    for (const op of ['resume', 'cancel'] as const) {
      const has = typeof port[op] === 'function';
      c.expect('M9', !!capabilities[op] === has, `capabilities.${op} is ${!!capabilities[op]}, but the member ${has ? 'implements' : 'does not implement'} ${op}`);
    }
    if (observed.checkpoints.length) c.expect('M9', capabilities.checkpoint === true, 'the member checkpointed, but capabilities.checkpoint is not true');
    if (observed.waited) c.expect('M9', capabilities.waits === true, 'the member returned waiting, but capabilities.waits is not true');
  }
  return c;
}
