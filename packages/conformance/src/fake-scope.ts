/** A RunScope that records what a topology asks of it, for the TopologyPort suite and for tests of a topology. */
import {
  inputText, matchesCondition,
  type CallOptions, type CallOutcome, type MemberResult, type RouteDecision, type RouteRequest, type RunInput, type RunScope, type TopologyLimits,
} from '@agent-plexus/core';

/** How a fake member answers one call: `n` counts the calls of that member, from 0. */
export type FakeMember = (input: RunInput, options: CallOptions, n: number) => MemberResult | Promise<MemberResult>;

export interface FakeCall {
  member: string;
  input: string;
  options: CallOptions;
  hopId: string;
  /** Share of the budget held while the call runs (undefined when the topology passed none). */
  share?: number;
  /** Shares of the calls in flight when this call started, its own included. */
  concurrentShares: (number | undefined)[];
  result?: MemberResult;
}

export interface FakeScopeOptions {
  /** Answers by member id; a member without one completes with `<member>(<input>)`. */
  members?: Record<string, FakeMember>;
  /** The router; default: the first candidate of a list, nobody for a filter. */
  route?: (request: RouteRequest, n: number) => RouteDecision | Promise<RouteDecision>;
  limits?: Partial<TopologyLimits>;
  input?: RunInput;
  signal?: AbortSignal;
}

export interface FakeScope extends RunScope {
  calls: FakeCall[];
  routes: RouteRequest[];
  abandoned: string[];
  /** Largest number of calls in flight at once. */
  maxInFlight: number;
}

export const DEFAULT_LIMITS: TopologyLimits = { maxParallel: 4, maxIterations: 3, maxHandoffs: 2 };

export const completed = (output: string): MemberResult => ({ status: 'completed', output });

/** Waits until the signal aborts, then answers `stopped` with code `aborted`; never answers without an abort. */
export const untilAborted: FakeMember = (_input, options) => new Promise((done) => {
  const stop = () => done({ status: 'stopped', output: '', reason: { code: 'aborted', layer: 'member' } });
  if (options.signal?.aborted) return stop();
  options.signal?.addEventListener('abort', stop, { once: true });
});

/**
 * A RunScope with fake members. Like the core, it lets at most `limits.maxParallel` calls run at once and queues the
 * others, first come first served.
 */
export function fakeScope(options: FakeScopeOptions = {}): FakeScope {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const input = options.input ?? 'hello';
  const counts = new Map<string, number>();
  const inFlight = new Set<FakeCall>();
  const queue: (() => void)[] = [];
  let hops = 0;
  let routed = 0;
  let busy = 0;

  const slot = (): Promise<void> => {
    if (busy < limits.maxParallel) {
      busy++;
      return Promise.resolve();
    }
    return new Promise((grant) => queue.push(() => { busy++; grant(); }));
  };
  const free = (): void => {
    busy--;
    queue.shift()?.();
  };

  const scope: FakeScope = {
    ctx: { runId: 'conformance-run', system: 'conformance', ...(options.signal ? { signal: options.signal } : {}) },
    input,
    limits,
    calls: [],
    routes: [],
    abandoned: [],
    maxInFlight: 0,
    async call(member: string, callInput: RunInput, callOptions: CallOptions): Promise<CallOutcome> {
      const hopId = `hop-${++hops}`;
      await slot();
      const call: FakeCall = { member, input: inputText(callInput), options: callOptions, hopId, concurrentShares: [] };
      if (callOptions?.share !== undefined) call.share = callOptions.share;
      inFlight.add(call);
      call.concurrentShares = [...inFlight].map((c) => c.share);
      scope.maxInFlight = Math.max(scope.maxInFlight, inFlight.size);
      scope.calls.push(call);
      const n = counts.get(member) ?? 0;
      counts.set(member, n + 1);
      try {
        const answer = options.members?.[member];
        const result = answer ? await answer(callInput, callOptions, n) : completed(`${member}(${inputText(callInput)})`);
        call.result = result;
        return { hopId, result };
      } finally {
        inFlight.delete(call);
        free();
      }
    },
    async route(request: RouteRequest): Promise<RouteDecision> {
      scope.routes.push(request);
      const n = routed++;
      if (options.route) return options.route(request, n);
      const first = Array.isArray(request.candidates) ? request.candidates[0] : undefined;
      return first ? { member: first } : {};
    },
    matches: (condition, result) => matchesCondition(condition, result, {}),
    abandon(hopId: string): void {
      scope.abandoned.push(hopId);
    },
  };
  return scope;
}
