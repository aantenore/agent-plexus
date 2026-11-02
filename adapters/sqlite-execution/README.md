# @agent-plexus/adapter-sqlite-execution

Maps **SQLite through `node:sqlite`** → **ExecutionPort** (layer `execution`). Tiers: prototype and production.

Keeps the journal of each run in one SQLite file. A new instance on the same file resumes the runs of the old one, so a
run survives a restart. No dependency: it uses the `node:sqlite` module that ships with Node.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | required | Database file, relative to the system config directory; its folder is created. `:memory:` works but keeps nothing after close |
| `maxRuns` | integer | `1000` | Runs kept; ended runs are dropped oldest first |
| `busyTimeoutMs` | integer | `5000` | How long a write waits for another process holding the file |
| `leaseMs` | integer | `600000` | How long a run stays held by the instance that began it after its last write |

```json
{ "ports": { "execution": { "adapter": "sqlite-execution", "options": { "path": ".plexus/journal.db" } } } }
```

## Behaviour

| Operation | Behaviour |
|---|---|
| `begin(runKey)` | New run, or the stored run with that key (also one that ended `waiting`); its last status stays until `end`. Holds the run for this instance: while another instance holds it, rejects with `RunBusyError` (`code` `RUN_BUSY`) |
| `step(name, fn)` | Runs `fn` once; later calls, also after a restart, return the stored result. A throwing `fn` stores nothing. Concurrent calls in one process share one run, also through two `begin` of the same run |
| `wait(name, untilAt)` | Resolves with the value given by `signal`, or `undefined` at `untilAt`; the result is stored. The timer does not keep the process alive |
| `signal(runKey, name, value)` | Releases the waiters of `name`; a signal that comes first is stored for the next `wait`, also one made after a restart. First wins, in one transaction and across processes: `true` when stored or delivered, `false` when `name` was already signalled or its wait settled. Unknown run: error |
| `put(text)` / `read(key)` | Key is `<runKey>:t<n>`; texts stay readable after the run ended |
| `remember(key, value)` / `recall(key)` | A small JSON value kept for the run, such as a remote task handle |
| `end(status)` | Stores the status, lets go of the hold and applies `maxRuns` |
| `release()` | Lets go of the hold; the status stays what it was |
| `close()` | Fails the waits still pending in this process, lets go of this instance's holds and closes the file |

Step results, kept values and signal values are stored as JSON, so a replay returns exactly what a resume would. A value
with no JSON form fails with a `TypeError` that names it, and nothing is stored.

## Durability

- The file is opened in WAL mode; every write is one transaction, so a crash leaves the last committed state. The
  default `synchronous` level is kept, so a commit is on disk when the call returns.
- A step is journaled after `fn` returns. A crash in between runs `fn` again on resume, as with every journal of this
  kind; keep a task handle with `remember` to continue instead of sending again.
- `wait` is not a wake-up across processes. A waiter hears signals sent in its own process at once. A signal stored by
  another process is seen by a `wait` made after it, and by a waiter at its deadline.
- `wait` returns a signal that arrived before it, even when its deadline has already passed; `System.resume` relies on
  this.
- Several processes may share the file; each write holds the lock for one transaction and waits up to `busyTimeoutMs`.
- One instance holds a run at a time. `begin` takes the hold in its transaction; `end`, `release` and `close` let go
  of it. Every write of the holder extends it by `leaseMs`; past that another instance may take the run over, and the
  old holder's next write fails with `RUN_BUSY`. A process that crashed therefore blocks its runs for up to `leaseMs`.
  Within one instance the hold does not exclude a second `begin`: the core runs one invocation per run in its process.
  A held run is never dropped by `maxRuns`.
- The tables carry `PRAGMA user_version` (now `2`; a version `1` file gets the hold columns when opened). A file with a
  newer version is refused, not changed.
- A run dropped by `maxRuns` takes its rows with it; a handle to it fails on the next write with an error that names the
  run.

## Node versions

This package requires Node 22.18 or later. On Node 24.15 importing `node:sqlite` and opening a database print no
`ExperimentalWarning` (checked with a `process.on('warning')` listener). Node 22 was not checked here and may print it;
`--disable-warning=ExperimentalWarning` silences it. The module is young, so check its Node documentation when you move
to a new major version.

## Limits

| Limit | Default | Why |
|---|---|---|
| `options.maxRuns` | 1000 | Runs, with their steps and texts, kept in the file |
| `options.busyTimeoutMs` | 5000 ms | How long a write waits for another process before it fails |
| `options.leaseMs` | 600000 ms | How long a run stays held after its holder's last write; keep it longer than the slowest step |

Runs in progress and held runs are never dropped, so the count can exceed `maxRuns` while they run. A run that ended `waiting` is
dropped last among the ended ones, since it may still resume.
