import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defineAdapter, PORT_VERSIONS,
  type AdapterContext, type Execution, type ExecutionPort, type MemberResult,
} from '@agent-plexus/core';

export interface FileExecutionOptions {
  /** Directory of the journal files, relative to the system config directory. Default: a fresh temp directory, removed on close. */
  dir?: string;
}

const NAME = 'file-execution';
const MAX_TIMER_MS = 2_147_483_647;

/** A value as JSON text; no `json` for a value without a JSON form (undefined). */
interface Stored {
  json?: string;
}

/** What one run keeps on disk, in `<dir>/<run key>.json`. */
interface RunFile {
  runKey: string;
  status?: MemberResult['status'];
  steps: Record<string, Stored>;
  waits: Record<string, Stored>;
  signals: Record<string, Stored>;
  /** Values kept with `remember`; absent in files written before it existed. */
  kept?: Record<string, Stored>;
  texts: Record<string, string>;
  textCount: number;
}

/** A wait in flight: `release` settles it with a value, `fail` rejects it (close). */
interface Waiter {
  release(value: Stored): void;
  fail(err: Error): void;
}

/** A run in memory: its file content, the steps and waits in flight, and the chain that orders its writes. */
interface Run {
  file: RunFile;
  path: string;
  inflight: Map<string, Promise<unknown>>;
  pending: Map<string, Waiter[]>;
  writes: Promise<void>;
}

const store = (value: unknown): Stored => {
  const json = JSON.stringify(value);
  return json === undefined ? {} : { json };
};
const load = (stored: Stored): unknown => (stored.json === undefined ? undefined : JSON.parse(stored.json));

const emptyFile = (runKey: string): RunFile => ({ runKey, steps: {}, waits: {}, signals: {}, texts: {}, textCount: 0 });

/** Journal in JSON files, one per run. A new instance on the same directory resumes the runs of the old one. */
export function createFileExecution(options: FileExecutionOptions, ctx: Pick<AdapterContext, 'name' | 'cwd'>): ExecutionPort & { close(): Promise<void> } {
  const given = options.dir === undefined ? undefined : resolve(ctx.cwd, options.dir);
  const runs = new Map<string, Run>();
  let made: string | undefined;
  let ready: Promise<string> | undefined;

  const directory = (): Promise<string> => {
    ready ??= (given ? mkdir(given, { recursive: true }).then(() => given) : mkdtemp(join(tmpdir(), 'agent-plexus-')).then((d) => (made = d)));
    return ready;
  };

  /** The run in memory, else the one on disk; `create` makes it when it exists nowhere. */
  async function open(runKey: string, create: boolean): Promise<Run | undefined> {
    const cached = runs.get(runKey);
    if (cached) return cached;
    const path = join(await directory(), `${encodeURIComponent(runKey)}.json`);
    let file: RunFile | undefined;
    try {
      file = JSON.parse(await readFile(path, 'utf8')) as RunFile;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw new Error(`${NAME}: cannot read ${path}: ${(err as Error).message}`);
    }
    if (!file && !create) return undefined;
    const again = runs.get(runKey);
    if (again) return again;
    const run: Run = { file: file ?? emptyFile(runKey), path, inflight: new Map(), pending: new Map(), writes: Promise.resolve() };
    runs.set(runKey, run);
    return run;
  }

  /** Writes the run's file after the writes already queued; a failed write is reported to its caller only. */
  function persist(run: Run): Promise<void> {
    const next = run.writes.then(async () => {
      const tmp = `${run.path}.tmp`;
      await writeFile(tmp, JSON.stringify(run.file), 'utf8');
      await rename(tmp, run.path);
    });
    run.writes = next.catch(() => undefined);
    return next;
  }

  function settle(run: Run, name: string, value: Stored): void {
    if (Object.hasOwn(run.file.waits, name)) return;
    run.file.waits[name] = value;
    const waiters = run.pending.get(name) ?? [];
    run.pending.delete(name);
    for (const waiter of waiters) waiter.release(value);
  }

  const execution = (run: Run): Execution => ({
    runKey: run.file.runKey,
    step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (Object.hasOwn(run.file.steps, name)) return Promise.resolve(load(run.file.steps[name] as Stored) as T);
      const running = run.inflight.get(name);
      if (running) return running as Promise<T>;
      const call = (async () => {
        const stored = store(await fn());
        run.file.steps[name] = stored;
        await persist(run);
        return load(stored);
      })().finally(() => run.inflight.delete(name));
      run.inflight.set(name, call);
      return call as Promise<T>;
    },
    wait(name, untilAt) {
      if (Object.hasOwn(run.file.waits, name)) return Promise.resolve(load(run.file.waits[name] as Stored));
      const until = Date.parse(untilAt);
      if (Number.isNaN(until)) return Promise.reject(new TypeError(`${NAME}: untilAt "${untilAt}" is not a date`));
      if (Object.hasOwn(run.file.signals, name)) {
        const early = run.file.signals[name] as Stored;
        delete run.file.signals[name];
        settle(run, name, early);
        return persist(run).then(() => load(early));
      }
      return new Promise<unknown>((done, fail) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiters = run.pending.get(name) ?? [];
        waiters.push({
          release(value) {
            if (timer) clearTimeout(timer);
            void persist(run).catch(() => undefined);
            done(load(value));
          },
          fail(err) {
            if (timer) clearTimeout(timer);
            fail(err);
          },
        });
        run.pending.set(name, waiters);
        const arm = (): void => {
          const left = until - Date.now();
          if (left <= 0) return settle(run, name, {});
          timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
          timer.unref();
        };
        arm();
      });
    },
    async put(text) {
      if (typeof text !== 'string') throw new TypeError(`${NAME}: put needs a string`);
      const key = `${run.file.runKey}:t${++run.file.textCount}`;
      run.file.texts[key] = text;
      await persist(run);
      return key;
    },
    async remember(key, value) {
      if (typeof key !== 'string' || !key) throw new TypeError(`${NAME}: remember needs a non-empty key`);
      (run.file.kept ??= {})[key] = store(value);
      await persist(run);
    },
    async recall(key) {
      const kept = run.file.kept;
      return kept && Object.hasOwn(kept, key) ? load(kept[key] as Stored) : undefined;
    },
    async end(status) {
      run.file.status = status;
      await persist(run);
    },
  });

  return {
    name: ctx.name,
    async begin(runKey) {
      if (typeof runKey !== 'string' || !runKey) throw new TypeError(`${NAME}: runKey must be a non-empty string`);
      // Not exclusive: two processes on one directory can run the same run at once. Prototype only.
      return execution((await open(runKey, true)) as Run);
    },
    async signal(runKey, name, value) {
      const run = await open(runKey, false);
      if (!run) throw new Error(`${NAME}: unknown run "${runKey}"`);
      // First wins: a name already signalled, or whose wait settled, takes no other value.
      if (Object.hasOwn(run.file.waits, name) || Object.hasOwn(run.file.signals, name)) return false;
      const stored = store(value);
      if (run.pending.has(name)) settle(run, name, stored);
      else run.file.signals[name] = stored;
      await persist(run);
      return true;
    },
    async read(key) {
      const at = key.lastIndexOf(':t');
      if (at < 0) return undefined;
      const run = await open(key.slice(0, at), false);
      return run && Object.hasOwn(run.file.texts, key) ? run.file.texts[key] : undefined;
    },
    async close() {
      const err = new Error(`${NAME}: closed while waiting`);
      for (const run of runs.values()) {
        const waiters = [...run.pending.values()].flat();
        run.pending.clear();
        for (const waiter of waiters) waiter.fail(err);
      }
      await Promise.allSettled([...runs.values()].map((r) => r.writes));
      if (made) await rm(made, { recursive: true, force: true });
    },
  };
}

export const adapter = defineAdapter<'ExecutionPort', FileExecutionOptions>({
  fills: 'ExecutionPort',
  name: NAME,
  maps: { technology: 'JSON files in a directory' },
  portVersion: PORT_VERSIONS.ExecutionPort,
  tiers: ['prototype'],
  description: 'Keeps the journal of each run in a JSON file: a new instance on the same directory resumes the runs of the old one. Prototype only: no hold across processes (two processes may run one run at once), no cleanup of ended runs.',
  optionsSchema: {
    type: 'object',
    properties: { dir: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
  create: (options, ctx) => createFileExecution(options, ctx),
});

export const adapters = [adapter];
