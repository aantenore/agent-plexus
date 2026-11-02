import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  defineAdapter,
  defineLimits,
  PORT_VERSIONS,
  RunBusyError,
  type AdapterContext,
  type Execution,
  type ExecutionPort,
  type MemberResult,
} from '@agent-plexus/core';

export interface SqliteExecutionOptions {
  /** Database file, relative to the system config directory. Its folder is created. `:memory:` works but is not durable. */
  path: string;
  /** Runs kept; ended runs are dropped oldest first, runs in progress never. */
  maxRuns?: number;
  /** How long a write waits for another process holding the file, in milliseconds. */
  busyTimeoutMs?: number;
  /** How long an instance holds a run after `begin` or its last write, in milliseconds, unless it ends or lets go first. */
  leaseMs?: number;
}

export const limits = defineLimits({
  maxRuns: {
    path: 'options.maxRuns',
    default: 1000,
    unit: 'count',
    min: 1,
    integer: true,
    why: 'Runs kept in the database, with their stored steps and texts; ended runs are dropped oldest first.',
  },
  busyTimeoutMs: {
    path: 'options.busyTimeoutMs',
    default: 5000,
    unit: 'ms',
    min: 0,
    integer: true,
    why: 'How long a write waits for another process that holds the database file before it fails.',
  },
  leaseMs: {
    path: 'options.leaseMs',
    default: 600_000,
    unit: 'ms',
    min: 1,
    integer: true,
    why: 'How long a run stays held by the instance that began it after its last write; past it, a process that crashed no longer blocks the run. Longer than the slowest step.',
  },
});

const NAME = 'sqlite-execution';
const MAX_TIMER_MS = 2_147_483_647;
/** Bumped with each change of the tables; `migrate` upgrades older files. */
const SCHEMA_VERSION = 2;

/** Version 1: the tables. */
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS runs (
    key TEXT PRIMARY KEY,
    status TEXT,
    ended_seq INTEGER,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runs_ended ON runs (ended_seq);
  CREATE TABLE IF NOT EXISTS steps (
    run TEXT NOT NULL REFERENCES runs (key) ON DELETE CASCADE,
    name TEXT NOT NULL,
    json TEXT,
    PRIMARY KEY (run, name)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS texts (
    run TEXT NOT NULL REFERENCES runs (key) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (run, n)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS kept (
    run TEXT NOT NULL REFERENCES runs (key) ON DELETE CASCADE,
    key TEXT NOT NULL,
    json TEXT,
    PRIMARY KEY (run, key)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS signals (
    run TEXT NOT NULL REFERENCES runs (key) ON DELETE CASCADE,
    name TEXT NOT NULL,
    json TEXT,
    PRIMARY KEY (run, name)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS waits (
    run TEXT NOT NULL REFERENCES runs (key) ON DELETE CASCADE,
    name TEXT NOT NULL,
    json TEXT,
    PRIMARY KEY (run, name)
  ) WITHOUT ROWID;
`;

/** Version 2: the hold on a run, the instance that has it and until when (ms since the epoch). */
const SCHEMA_V2 = `
  ALTER TABLE runs ADD COLUMN lease TEXT;
  ALTER TABLE runs ADD COLUMN lease_until INTEGER;
`;

/** The changes from each version to the next: index n upgrades version n to n + 1. */
const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2];

/** A stored value as JSON text; `null` stands for a value that has no JSON form (undefined itself). */
type Json = string | null;
type Row = Record<string, unknown> | undefined;

interface Waiter {
  resolve(value: Json): void;
  reject(err: unknown): void;
}

/** JSON text of a value; a value JSON cannot hold is a TypeError that names what it was. */
const encode = (value: unknown, what: string): Json => {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new TypeError(`${NAME}: ${what} is not JSON-serialisable: ${(err as Error).message}`);
  }
  return json ?? null;
};
const decode = (json: Json): unknown => (json === null ? undefined : JSON.parse(json));

const integerAtLeast = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min;

/** Journal in a SQLite file. A new instance on the same file resumes the runs of the old one. */
export function createSqliteExecution(
  options: SqliteExecutionOptions,
  ctx: Pick<AdapterContext, 'name' | 'cwd'>,
): ExecutionPort & { close(): Promise<void> } {
  if (typeof options?.path !== 'string' || !options.path) throw new TypeError(`${NAME}: path must be a non-empty string`);
  const maxRuns = options.maxRuns ?? limits.maxRuns.default;
  if (!integerAtLeast(maxRuns, limits.maxRuns.min)) throw new TypeError(`${NAME}: maxRuns must be an integer of at least 1`);
  const busyTimeoutMs = options.busyTimeoutMs ?? limits.busyTimeoutMs.default;
  if (!integerAtLeast(busyTimeoutMs, limits.busyTimeoutMs.min)) throw new TypeError(`${NAME}: busyTimeoutMs must be an integer of at least 0`);
  const leaseMs = options.leaseMs ?? limits.leaseMs.default;
  if (!integerAtLeast(leaseMs, limits.leaseMs.min)) throw new TypeError(`${NAME}: leaseMs must be an integer of at least 1`);
  /** This instance's holds: runs it began and has not ended or let go of. */
  const holder = randomUUID();

  const memory = options.path === ':memory:';
  const file = memory ? options.path : resolve(ctx.cwd, options.path);
  if (!memory) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: busyTimeoutMs });
  let closed = false;

  /** Runs `fn` in one write transaction: all of it or none of it. */
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const migrate = () => {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) throw new Error(`${NAME}: ${file} has schema version ${version}, this adapter knows up to ${SCHEMA_VERSION}`);
    if (version === SCHEMA_VERSION) return;
    tx(() => {
      for (const step of MIGRATIONS.slice(version)) db.exec(step);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  };

  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  migrate();

  const sql = {
    run: db.prepare('SELECT status, ended_seq, lease, lease_until FROM runs WHERE key = ?'),
    insertRun: db.prepare('INSERT INTO runs (key, created, lease, lease_until) VALUES (?, ?, ?, ?)'),
    hold: db.prepare('UPDATE runs SET lease = ?, lease_until = ? WHERE key = ?'),
    letGo: db.prepare('UPDATE runs SET lease = NULL, lease_until = NULL WHERE key = ? AND lease = ?'),
    letGoAll: db.prepare('UPDATE runs SET lease = NULL, lease_until = NULL WHERE lease = ?'),
    endRun: db.prepare('UPDATE runs SET status = ?, ended_seq = (SELECT COALESCE(MAX(ended_seq), 0) + 1 FROM runs), lease = NULL, lease_until = NULL WHERE key = ?'),
    runCount: db.prepare('SELECT COUNT(*) AS n FROM runs'),
    evictable: db.prepare("SELECT key FROM runs WHERE ended_seq IS NOT NULL AND (lease IS NULL OR lease_until <= ?) ORDER BY (status = 'waiting'), ended_seq LIMIT ?"),
    deleteRun: db.prepare('DELETE FROM runs WHERE key = ?'),
    step: db.prepare('SELECT json FROM steps WHERE run = ? AND name = ?'),
    insertStep: db.prepare('INSERT OR IGNORE INTO steps (run, name, json) VALUES (?, ?, ?)'),
    wait: db.prepare('SELECT json FROM waits WHERE run = ? AND name = ?'),
    insertWait: db.prepare('INSERT OR IGNORE INTO waits (run, name, json) VALUES (?, ?, ?)'),
    signal: db.prepare('SELECT json FROM signals WHERE run = ? AND name = ?'),
    insertSignal: db.prepare('INSERT OR IGNORE INTO signals (run, name, json) VALUES (?, ?, ?)'),
    deleteSignal: db.prepare('DELETE FROM signals WHERE run = ? AND name = ?'),
    nextText: db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM texts WHERE run = ?'),
    insertText: db.prepare('INSERT INTO texts (run, n, text) VALUES (?, ?, ?)'),
    text: db.prepare('SELECT text FROM texts WHERE run = ? AND n = ?'),
    keep: db.prepare('INSERT OR REPLACE INTO kept (run, key, json) VALUES (?, ?, ?)'),
    kept: db.prepare('SELECT json FROM kept WHERE run = ? AND key = ?'),
  } satisfies Record<string, StatementSync>;

  /** Waiters in this process, per run and wait name. */
  const pending = new Map<string, Waiter[]>();
  const pendingKey = (run: string, name: string) => JSON.stringify([run, name]);
  /** Steps running in this process, per run and step name: two `begin` of one run share them. */
  const inflight = new Map<string, Promise<unknown>>();

  const json = (row: Row): Json => (row ? ((row.json as Json | undefined) ?? null) : null);

  /** Ends the run's rows when it is gone, which happens when `maxRuns` dropped it. Call inside a transaction. */
  const assertRun = (runKey: string) => {
    if (!sql.run.get(runKey)) throw new Error(`${NAME}: run "${runKey}" was dropped by maxRuns`);
  };

  /**
   * Holds the run for a write of this instance and extends the hold when it is this instance's. A run another instance
   * holds is not written: this instance's hold expired and was taken over. Call inside a transaction.
   */
  const holdFor = (runKey: string) => {
    const row = sql.run.get(runKey) as Row;
    if (!row) throw new Error(`${NAME}: run "${runKey}" was dropped by maxRuns`);
    if (row.lease === holder) sql.hold.run(holder, Date.now() + leaseMs, runKey);
    else if (row.lease !== null) throw new RunBusyError(runKey, `${NAME}: run "${runKey}" is held by another invocation`);
  };

  /**
   * Drops ended runs beyond `maxRuns`, oldest first; one that ended waiting goes last, since it may still resume. A run
   * held by an invocation is kept, whatever its last status.
   */
  const evict = () => {
    const total = (sql.runCount.get() as { n: number }).n;
    if (total <= maxRuns) return;
    for (const row of sql.evictable.all(Date.now(), total - maxRuns) as { key: string }[]) sql.deleteRun.run(row.key);
  };

  /** Stores the wait result once and drops the signal it took; returns the stored result. Call inside a transaction. */
  const store = (runKey: string, name: string, value: Json): Json => {
    assertRun(runKey);
    sql.insertWait.run(runKey, name, value);
    sql.deleteSignal.run(runKey, name);
    return json(sql.wait.get(runKey, name) as Row);
  };

  /** Settles the waiters of `name` in this process with `value`, or fails them with `err`. */
  const release = (runKey: string, name: string, outcome: { value: Json } | { err: unknown }) => {
    const key = pendingKey(runKey, name);
    const waiters = pending.get(key) ?? [];
    pending.delete(key);
    for (const waiter of waiters) 'err' in outcome ? waiter.reject(outcome.err) : waiter.resolve(outcome.value);
  };

  const execution = (runKey: string): Execution => ({
    runKey,
    step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const done = sql.step.get(runKey, name) as Row;
      if (done) return Promise.resolve(decode(json(done)) as T);
      const at = pendingKey(runKey, name);
      const running = inflight.get(at);
      if (running) return running.then((v) => v as T);
      const call = (async () => {
        const result = encode(await fn(), `result of step "${name}"`);
        // Another process may have stored the step meanwhile; its result wins.
        const stored = tx(() => {
          holdFor(runKey);
          sql.insertStep.run(runKey, name, result);
          return json(sql.step.get(runKey, name) as Row);
        });
        return decode(stored);
      })().finally(() => inflight.delete(at));
      inflight.set(at, call);
      return call as Promise<T>;
    },
    wait(name, untilAt) {
      const settled = sql.wait.get(runKey, name) as Row;
      if (settled) return Promise.resolve(decode(json(settled)));
      const until = Date.parse(untilAt);
      if (Number.isNaN(until)) return Promise.reject(new TypeError(`${NAME}: untilAt "${untilAt}" is not a date`));
      /** The persisted signal of `name`, taken as the result of the wait. */
      const take = (): Json | undefined => {
        const early = sql.signal.get(runKey, name) as Row;
        return early ? store(runKey, name, json(early)) : undefined;
      };
      if (sql.signal.get(runKey, name)) {
        try {
          const early = tx(() => {
            holdFor(runKey);
            return take();
          });
          if (early !== undefined) return Promise.resolve(decode(early));
        } catch (err) {
          return Promise.reject(err);
        }
      }
      return new Promise<unknown>((resolveWait, rejectWait) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const key = pendingKey(runKey, name);
        const waiters = pending.get(key) ?? [];
        waiters.push({
          resolve(value) {
            if (timer) clearTimeout(timer);
            resolveWait(decode(value));
          },
          reject(err) {
            if (timer) clearTimeout(timer);
            rejectWait(err);
          },
        });
        pending.set(key, waiters);
        const arm = () => {
          const left = until - Date.now();
          if (left > 0) {
            timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
            timer.unref();
            return;
          }
          // Deadline: a signal another process stored meanwhile still counts; otherwise the wait settles empty.
          try {
            const value = tx(() => {
              holdFor(runKey);
              const taken = take();
              return taken !== undefined ? taken : store(runKey, name, null);
            });
            release(runKey, name, { value });
          } catch (err) {
            release(runKey, name, { err });
          }
        };
        arm();
      });
    },
    async put(text) {
      if (typeof text !== 'string') throw new TypeError(`${NAME}: put needs a string`);
      return tx(() => {
        holdFor(runKey);
        const n = (sql.nextText.get(runKey) as { n: number }).n;
        sql.insertText.run(runKey, n, text);
        return `${runKey}:t${n}`;
      });
    },
    async remember(key, value) {
      if (typeof key !== 'string' || !key) throw new TypeError(`${NAME}: remember needs a non-empty key`);
      const stored = encode(value, `value kept under "${key}"`);
      tx(() => {
        holdFor(runKey);
        sql.keep.run(runKey, key, stored);
      });
    },
    async recall(key) {
      const row = sql.kept.get(runKey, key) as Row;
      return row ? decode(json(row)) : undefined;
    },
    async end(status: MemberResult['status']) {
      tx(() => {
        holdFor(runKey);
        sql.endRun.run(status, runKey);
        evict();
      });
    },
    async release() {
      tx(() => {
        sql.letGo.run(runKey, holder);
      });
    },
  });

  return {
    name: ctx.name,
    async begin(runKey) {
      if (typeof runKey !== 'string' || !runKey) throw new TypeError(`${NAME}: runKey must be a non-empty string`);
      // The hold is this instance's: one invocation per run within it is the core's to ensure.
      tx(() => {
        const now = Date.now();
        const row = sql.run.get(runKey) as Row;
        if (!row) {
          sql.insertRun.run(runKey, now, holder, now + leaseMs);
          evict();
        } else if (row.lease === null || row.lease === holder || (row.lease_until as number) <= now) {
          sql.hold.run(holder, now + leaseMs, runKey);
        } else {
          throw new RunBusyError(runKey, `${NAME}: run "${runKey}" is held by another invocation`);
        }
      });
      return execution(runKey);
    },
    async signal(runKey, name, value) {
      if (!sql.run.get(runKey)) throw new Error(`${NAME}: unknown run "${runKey}"`);
      const stored = encode(value, `signal "${name}"`);
      const waiting = pending.has(pendingKey(runKey, name));
      // First wins, across processes too: a name already signalled, or whose wait settled, takes no other value.
      const outcome = tx((): { kept: boolean; settled?: Json } => {
        assertRun(runKey);
        if (sql.wait.get(runKey, name)) return { kept: false };
        if (waiting) {
          if (sql.signal.get(runKey, name)) return { kept: false };
          return { kept: true, settled: store(runKey, name, stored) };
        }
        return { kept: Number(sql.insertSignal.run(runKey, name, stored).changes) === 1 };
      });
      if (outcome.settled !== undefined) release(runKey, name, { value: outcome.settled });
      return outcome.kept;
    },
    async read(key) {
      const at = key.lastIndexOf(':t');
      if (at < 0) return undefined;
      const suffix = key.slice(at + 2);
      if (!/^[1-9]\d*$/.test(suffix)) return undefined;
      const row = sql.text.get(key.slice(0, at), Number(suffix)) as Row;
      return row ? (row.text as string) : undefined;
    },
    async close() {
      if (closed) return;
      closed = true;
      const err = new Error(`${NAME}: closed while waiting`);
      for (const key of [...pending.keys()]) {
        const [runKey, name] = JSON.parse(key) as [string, string];
        release(runKey, name, { err });
      }
      try {
        sql.letGoAll.run(holder);
      } finally {
        db.close();
      }
    },
  };
}

export const adapter = defineAdapter<'ExecutionPort', SqliteExecutionOptions>({
  fills: 'ExecutionPort',
  name: NAME,
  maps: { technology: 'SQLite through node:sqlite' },
  portVersion: PORT_VERSIONS.ExecutionPort,
  tiers: ['prototype', 'production'],
  description: 'Keeps the journal of each run in a SQLite file: a new instance on the same file resumes the runs of the old one, and one instance holds a run at a time.',
  optionsSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      maxRuns: { type: 'integer', minimum: limits.maxRuns.min },
      busyTimeoutMs: { type: 'integer', minimum: limits.busyTimeoutMs.min },
      leaseMs: { type: 'integer', minimum: limits.leaseMs.min },
    },
    required: ['path'],
    additionalProperties: false,
  },
  limits,
  create: (options, ctx) => createSqliteExecution(options, ctx),
});

export const adapters = [adapter];
