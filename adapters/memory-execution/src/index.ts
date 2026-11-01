import {
  defineAdapter,
  defineLimits,
  PORT_VERSIONS,
  type AdapterContext,
  type Execution,
  type ExecutionPort,
  type MemberResult,
} from '@agent-plexus/core';

export interface MemoryExecutionOptions {
  /** Runs kept in memory; ended runs are dropped oldest first, runs in progress never. */
  maxRuns?: number;
}

export const limits = defineLimits({
  maxRuns: {
    path: 'options.maxRuns',
    default: 1000,
    unit: 'count',
    min: 1,
    integer: true,
    why: 'Runs kept in memory, with their stored steps and texts; ended runs are dropped oldest first.',
  },
});

/** A stored value as JSON text; `undefined` stands for a value that has no JSON form (undefined itself). */
type Stored = { json: string | undefined };

interface Run {
  key: string;
  steps: Map<string, Stored>;
  inflight: Map<string, Promise<unknown>>;
  /** Wait results, once settled. */
  waits: Map<string, Stored>;
  /** Waiters not settled yet, per wait name. */
  pending: Map<string, ((value: Stored) => void)[]>;
  /** Signals that arrived before their wait. */
  signals: Map<string, Stored>;
  /** Values kept with `remember`. */
  kept: Map<string, Stored>;
  texts: Map<string, string>;
  textCount: number;
  endedSeq?: number;
  status?: MemberResult['status'];
}

const MAX_TIMER_MS = 2_147_483_647;

const store = (value: unknown): Stored => {
  const json = JSON.stringify(value);
  return { json };
};
const load = (stored: Stored): unknown => (stored.json === undefined ? undefined : JSON.parse(stored.json));

/** In-memory journal. Runs resume while the process lives and are lost on restart. */
export function createMemoryExecution(options: MemoryExecutionOptions = {}, ctx: Pick<AdapterContext, 'name'>): ExecutionPort {
  const maxRuns = options.maxRuns ?? limits.maxRuns.default;
  if (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns) || maxRuns < limits.maxRuns.min) {
    throw new TypeError('memory-execution: maxRuns must be an integer of at least 1');
  }
  const runs = new Map<string, Run>();
  let endSeq = 0;

  const evict = () => {
    while (runs.size > maxRuns) {
      // Ended runs only; a run that ended waiting may still resume, so it goes last.
      const ended = [...runs.values()].filter((r) => r.endedSeq !== undefined);
      const order = (r: Run) => (r.status === 'waiting' ? 1 : 0);
      ended.sort((a, b) => order(a) - order(b) || (a.endedSeq as number) - (b.endedSeq as number));
      const oldest = ended[0];
      if (!oldest) return;
      runs.delete(oldest.key);
    }
  };

  const settle = (run: Run, name: string, value: Stored) => {
    if (run.waits.has(name)) return;
    run.waits.set(name, value);
    const waiters = run.pending.get(name) ?? [];
    run.pending.delete(name);
    for (const resolve of waiters) resolve(value);
  };

  const execution = (run: Run): Execution => ({
    runKey: run.key,
    step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const done = run.steps.get(name);
      if (done) return Promise.resolve(load(done) as T);
      const running = run.inflight.get(name);
      if (running) return running.then((v) => v as T);
      const call = (async () => {
        const stored = store(await fn());
        run.steps.set(name, stored);
        return load(stored);
      })().finally(() => run.inflight.delete(name));
      run.inflight.set(name, call);
      return call as Promise<T>;
    },
    wait(name, untilAt) {
      const settled = run.waits.get(name);
      if (settled) return Promise.resolve(load(settled));
      const until = Date.parse(untilAt);
      if (Number.isNaN(until)) return Promise.reject(new TypeError(`memory-execution: untilAt "${untilAt}" is not a date`));
      const early = run.signals.get(name);
      if (early) {
        run.signals.delete(name);
        settle(run, name, early);
        return Promise.resolve(load(early));
      }
      return new Promise<unknown>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiters = run.pending.get(name) ?? [];
        waiters.push((value) => {
          if (timer) clearTimeout(timer);
          resolve(load(value));
        });
        run.pending.set(name, waiters);
        const arm = () => {
          const left = until - Date.now();
          if (left <= 0) return settle(run, name, { json: undefined });
          timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
          timer.unref();
        };
        arm();
      });
    },
    async put(text) {
      if (typeof text !== 'string') throw new TypeError('memory-execution: put needs a string');
      const key = `${run.key}:t${++run.textCount}`;
      run.texts.set(key, text);
      return key;
    },
    async remember(key, value) {
      if (typeof key !== 'string' || !key) throw new TypeError('memory-execution: remember needs a non-empty key');
      run.kept.set(key, store(value));
    },
    async recall(key) {
      const stored = run.kept.get(key);
      return stored ? load(stored) : undefined;
    },
    async end(status) {
      run.status = status;
      run.endedSeq = ++endSeq;
      evict();
    },
  });

  return {
    name: ctx.name,
    async begin(runKey) {
      if (typeof runKey !== 'string' || !runKey) throw new TypeError('memory-execution: runKey must be a non-empty string');
      let run = runs.get(runKey);
      if (run) {
        delete run.endedSeq;
        delete run.status;
      } else {
        run = { key: runKey, steps: new Map(), inflight: new Map(), waits: new Map(), pending: new Map(), signals: new Map(), kept: new Map(), texts: new Map(), textCount: 0 };
        runs.set(runKey, run);
        evict();
      }
      return execution(run);
    },
    async signal(runKey, name, value) {
      const run = runs.get(runKey);
      if (!run) throw new Error(`memory-execution: unknown run "${runKey}"`);
      const stored = store(value);
      if (run.waits.has(name)) return;
      if (run.pending.has(name)) settle(run, name, stored);
      else run.signals.set(name, stored);
    },
    async read(key) {
      const at = key.lastIndexOf(':t');
      if (at < 0) return undefined;
      return runs.get(key.slice(0, at))?.texts.get(key);
    },
  };
}

export const adapter = defineAdapter<'ExecutionPort', MemoryExecutionOptions>({
  fills: 'ExecutionPort',
  name: 'memory-execution',
  maps: { technology: 'in-process memory' },
  portVersion: PORT_VERSIONS.ExecutionPort,
  tiers: ['prototype'],
  description: 'Keeps the journal of each run in memory: runs resume while the process lives and are lost on restart.',
  optionsSchema: {
    type: 'object',
    properties: { maxRuns: { type: 'integer', minimum: limits.maxRuns.min } },
    additionalProperties: false,
  },
  limits,
  create: (options, ctx) => createMemoryExecution(options, ctx),
});

export const adapters = [adapter];
