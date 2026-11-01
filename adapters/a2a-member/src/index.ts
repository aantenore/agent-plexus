import { randomUUID } from 'node:crypto';
import { Role, type Message, type SendMessageRequest, type Task } from '@a2a-js/sdk';
import { ServiceParameters, withA2AExtensions, type RequestOptions } from '@a2a-js/sdk/client';
import {
  defineAdapter,
  defineLimits,
  inputText,
  limitNumber,
  limitProblem,
  PORT_VERSIONS,
  UNBOUNDED,
  type AdapterContext,
  type LimitValue,
  type MemberCallContext,
  type MemberPort,
  type MemberResult,
  type RunInput,
} from '@agent-plexus/core';
import { boundsData, BOUNDS_URI } from './bounds.ts';
import { checkKeys, createTargetSource, entryOf, type PublicJwk, type Target } from './card.ts';
import { checkTarget, Refused, type TargetRules } from './guard.ts';
import { decodeRef, encodeRef, isActive, isTask, messageText, settled, taskResult } from './task.ts';

export { BOUNDS_URI } from './bounds.ts';
export { STATE_EXT } from './task.ts';

export interface A2AMemberOptions {
  /** Agent card URL (`.../agent-card.json`) or the agent's JSON-RPC endpoint. */
  url: string;
  /** The JSON-RPC endpoint, when the card is not to be trusted for it; the card is still read for the entry. */
  endpoint?: string;
  /** URLs or origins a card may point to besides its own origin. */
  allowedEndpoints?: string[];
  /** Allow plain http to hosts that are not loopback (default false). */
  allowHttp?: boolean;
  /** Credential audience; from config, never from the card. */
  audience?: string;
  /** Public keys (JWKs) or the URL of a JWKS document, to verify the card signatures. */
  keys?: PublicJwk[] | string;
  /** Refuse a card that is unsigned or not verified by `keys` (default false). */
  requireSigned?: boolean;
  /** Static headers sent with every call to the endpoint (not with the card or key fetches). */
  headers?: Record<string, string>;
  /** Time limit of one call, polling included; capped by the time left of the run. */
  timeoutMs?: LimitValue;
  /** Interval between GetTask calls while a task is working. */
  pollMs?: number;
  /** Largest agent card (or key set) read. */
  maxCardBytes?: number;
  /** Largest JSON-RPC answer read. */
  maxResponseBytes?: number;
  /** How long a fetched card is trusted. */
  cardTtlMs?: number;
  /** Time limit of the CancelTask that follows an abort or a deadline. */
  cancelTimeoutMs?: number;
}

export const limits = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 300_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 3_600_000 }, why: 'Time limit of one call, polling included; the time left of the run caps it further.' },
  pollMs: { path: 'options.pollMs', default: 500, unit: 'ms', min: 10, safe: { min: 100, max: 10_000 }, why: 'Interval of GetTask while the remote task is working.' },
  maxCardBytes: { path: 'options.maxCardBytes', default: 65_536, unit: 'bytes', min: 1024, max: 1_048_576, why: 'Largest agent card or key set read.' },
  maxResponseBytes: { path: 'options.maxResponseBytes', default: 4_194_304, unit: 'bytes', min: 1024, why: 'Largest JSON-RPC answer read from the remote agent.' },
  cardTtlMs: { path: 'options.cardTtlMs', default: 300_000, unit: 'ms', min: 0, max: 86_400_000, why: 'How long a fetched card and its endpoint are trusted.' },
  cancelTimeoutMs: { path: 'options.cancelTimeoutMs', default: 5000, unit: 'ms', min: 100, max: 60_000, why: 'Time limit of the CancelTask sent after an abort or a deadline.' },
});

const FAILED = 'remote agent call failed';
const MAX_TIMER_MS = 2_147_483_647;

function limitOf(key: keyof typeof limits, value: unknown): number {
  const spec = limits[key];
  const v = value === undefined ? spec.default : value;
  const problem = limitProblem(spec, v);
  if (problem) throw new TypeError(`a2a-member: ${key} ${problem}`);
  return limitNumber(v as LimitValue);
}

/** Resolves when `ms` pass; rejects with the signal's reason when it aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The promise's outcome, or the signal's reason when it aborts first. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Member that calls a remote agent over A2A through the official SDK client. */
export function createA2AMember(options: A2AMemberOptions, ctx: Pick<AdapterContext, 'name'>): MemberPort {
  const name = ctx.name;
  if (!options || typeof options.url !== 'string' || !options.url) throw new TypeError('a2a-member: url is required');
  for (const key of ['endpoint', 'audience'] as const) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key])) throw new TypeError(`a2a-member: ${key} must be a non-empty string`);
  }
  if (options.allowedEndpoints !== undefined && (!Array.isArray(options.allowedEndpoints) || options.allowedEndpoints.some((e) => typeof e !== 'string'))) {
    throw new TypeError('a2a-member: allowedEndpoints must be strings');
  }
  for (const key of ['allowHttp', 'requireSigned'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError(`a2a-member: ${key} must be a boolean`);
  }
  if (options.headers !== undefined && (typeof options.headers !== 'object' || options.headers === null || Object.values(options.headers).some((v) => typeof v !== 'string'))) {
    throw new TypeError('a2a-member: headers must be an object of strings');
  }
  if (options.requireSigned === true && options.keys === undefined) throw new TypeError('a2a-member: requireSigned needs keys');
  const keys = typeof options.keys === 'string' ? options.keys : options.keys === undefined ? undefined : checkKeys(options.keys);
  const timeoutMs = limitOf('timeoutMs', options.timeoutMs);
  const pollMs = limitOf('pollMs', options.pollMs);
  const maxCardBytes = limitOf('maxCardBytes', options.maxCardBytes);
  const maxResponseBytes = limitOf('maxResponseBytes', options.maxResponseBytes);
  const cardTtlMs = limitOf('cardTtlMs', options.cardTtlMs);
  const cancelTimeoutMs = limitOf('cancelTimeoutMs', options.cancelTimeoutMs);
  const allowedEndpoints = options.allowedEndpoints ?? [];

  const configuredUrls = [options.url, options.endpoint, ...allowedEndpoints, typeof keys === 'string' ? keys : undefined].filter((u): u is string => !!u);
  let rules: TargetRules;
  try {
    rules = { allowHttp: options.allowHttp === true, configured: new Set(configuredUrls.map((u) => new URL(u).origin)) };
    for (const u of configuredUrls) checkTarget(u, 'a configured URL', rules);
  } catch (error) {
    throw new TypeError(`a2a-member: ${error instanceof Refused ? error.message : 'a configured URL is not a URL'}`);
  }

  const source = createTargetSource(
    {
      url: options.url,
      allowedEndpoints,
      requireSigned: options.requireSigned === true,
      maxCardBytes,
      maxResponseBytes,
      cardTtlMs,
      fetchTimeoutMs: Math.min(timeoutMs, MAX_TIMER_MS),
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(keys !== undefined ? { keys } : {}),
    },
    rules,
  );

  /** Headers of a call: the static ones, then the bearer credential (which replaces a static `authorization`). */
  function parameters(call: MemberCallContext, withBounds: boolean): ServiceParameters {
    const params = ServiceParameters.create();
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      if (!(call.credential && k.toLowerCase() === 'authorization')) params[k] = v;
    }
    if (call.credential) params.Authorization = `Bearer ${call.credential}`;
    if (withBounds) withA2AExtensions(BOUNDS_URI)(params);
    return params;
  }

  /** A user message with the bounds as extension data, optionally continuing a task. */
  function userMessage(input: RunInput, call: MemberCallContext, remainingMs: number, ref?: { taskId: string; contextId: string }): SendMessageRequest {
    const message: Message = {
      messageId: randomUUID(),
      contextId: ref?.contextId ?? '',
      taskId: ref?.taskId ?? '',
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: inputText(input) }, metadata: undefined, filename: '', mediaType: '' }],
      metadata: { [BOUNDS_URI]: boundsData(call.outbound, remainingMs) },
      extensions: [BOUNDS_URI],
      referenceTaskIds: [],
    };
    return { tenant: '', message, configuration: undefined, metadata: undefined };
  }

  const failed = (detail: string): MemberResult => ({ status: 'failed', output: '', reason: { code: 'error', layer: 'member', by: name, detail } });

  /**
   * Runs one call: `begin` sends or reads the task, then the task is polled until it ends or waits. The time is bounded
   * by the smaller of `timeoutMs` and the time left of the run; an abort or the deadline cancels the remote task.
   */
  async function drive(
    call: MemberCallContext,
    begin: (target: Target, signal: AbortSignal, remainingMs: () => number) => Promise<Task | Message>,
    known?: string,
  ): Promise<MemberResult> {
    const budget = Math.min(timeoutMs, Number.isFinite(call.outbound.remainingMs) ? call.outbound.remainingMs : Infinity);
    const deadline = performance.now() + budget;
    const remaining = () => deadline - performance.now();
    const signals = [call.signal, Number.isFinite(budget) ? AbortSignal.timeout(Math.min(Math.max(budget, 0), MAX_TIMER_MS)) : undefined].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
    let target: Target | undefined;
    let taskId = known ? decodeRef(known)?.taskId : undefined;
    let checkpointedId = taskId;

    const stopped = (): MemberResult => ({
      status: 'stopped',
      output: '',
      reason: { code: call.signal?.aborted && remaining() > 0 ? 'aborted' : 'timeout', layer: 'member', by: name },
    });

    try {
      if (budget <= 0) return stopped();
      target = await until(source(), signal);
      let current = await begin(target, signal, remaining);
      for (;;) {
        if (!isTask(current)) return { status: 'completed', output: messageText(current) };
        taskId = current.id;
        const ref = encodeRef(current.id, current.contextId);
        if (settled(current) || !isActive(current)) return taskResult(current, name, ref);
        if (checkpointedId !== current.id) {
          await call.checkpoint(ref);
          checkpointedId = current.id;
        }
        await sleep(pollMs, signal);
        current = await target.client.getTask({ tenant: '', id: current.id }, { signal, serviceParameters: parameters(call, false) });
      }
    } catch (error) {
      if (signal.aborted) {
        if (target && taskId) await cancelRemote(target, taskId, call);
        return stopped();
      }
      // the remote task must not be left running when this side gives up
      if (target && taskId) await cancelRemote(target, taskId, call);
      return failed(error instanceof Refused ? error.message : FAILED);
    }
  }

  /** Best effort: the answer, or its absence, does not change what the caller gets. */
  async function cancelRemote(target: Target, taskId: string, call: MemberCallContext): Promise<void> {
    const options: RequestOptions = { signal: AbortSignal.timeout(cancelTimeoutMs), serviceParameters: parameters(call, false) };
    try {
      await target.client.cancelTask({ tenant: '', id: taskId, metadata: undefined }, options);
    } catch {
      // the remote task may have ended already
    }
  }

  const refused = (): MemberResult => failed('the task reference is not one of this member');

  return {
    name,
    async describe() {
      const signal = Number.isFinite(timeoutMs) ? AbortSignal.timeout(Math.min(timeoutMs, MAX_TIMER_MS)) : new AbortController().signal;
      return entryOf(name, await until(source(), signal), options.audience);
    },
    invoke: (input, call) =>
      drive(call, (target, signal, remaining) => target.client.sendMessage(userMessage(input, call, remaining()), { signal, serviceParameters: parameters(call, true) })),
    async resume(taskRef, input, call) {
      const ref = decodeRef(taskRef);
      if (!ref) return refused();
      return drive(
        call,
        (target, signal, remaining) =>
          input === undefined
            ? target.client.getTask({ tenant: '', id: ref.taskId }, { signal, serviceParameters: parameters(call, false) })
            : target.client.sendMessage(userMessage(input, call, remaining(), ref), { signal, serviceParameters: parameters(call, true) }),
        taskRef,
      );
    },
    async cancel(taskRef, call) {
      const ref = decodeRef(taskRef);
      if (!ref) throw new TypeError('a2a-member: the task reference is not one of this member');
      try {
        const signal = AbortSignal.timeout(cancelTimeoutMs);
        const target = await until(source(), signal);
        await target.client.cancelTask({ tenant: '', id: ref.taskId, metadata: undefined }, { signal, serviceParameters: parameters(call, false) });
      } catch {
        throw new Error('a2a-member: cancel failed');
      }
    },
  };
}

export const adapter = defineAdapter<'MemberPort', A2AMemberOptions>({
  fills: 'MemberPort',
  name: 'a2a-member',
  maps: { standard: 'Agent2Agent (A2A) 1.0, JSON-RPC binding' },
  portVersion: PORT_VERSIONS.MemberPort,
  tiers: ['prototype', 'production'],
  description: 'Calls a remote agent over A2A: card checks, endpoint pinning, bounded polling, resume and cancel.',
  optionsSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      endpoint: { type: 'string', minLength: 1 },
      allowedEndpoints: { type: 'array', items: { type: 'string', minLength: 1 } },
      allowHttp: { type: 'boolean' },
      audience: { type: 'string', minLength: 1 },
      keys: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'object' } }] },
      requireSigned: { type: 'boolean' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      timeoutMs: { oneOf: [{ type: 'integer', minimum: limits.timeoutMs.min }, { enum: [UNBOUNDED] }] },
      pollMs: { type: 'integer', minimum: limits.pollMs.min },
      maxCardBytes: { type: 'integer', minimum: limits.maxCardBytes.min, maximum: limits.maxCardBytes.max as number },
      maxResponseBytes: { type: 'integer', minimum: limits.maxResponseBytes.min },
      cardTtlMs: { type: 'integer', minimum: limits.cardTtlMs.min, maximum: limits.cardTtlMs.max as number },
      cancelTimeoutMs: { type: 'integer', minimum: limits.cancelTimeoutMs.min, maximum: limits.cancelTimeoutMs.max as number },
    },
    required: ['url'],
    additionalProperties: false,
  },
  limits,
  create: (options, ctx) => createA2AMember(options, ctx),
});

export const adapters = [adapter];
