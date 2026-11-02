# @agent-plexus/adapter-memory-execution

Maps **in-process memory** → **ExecutionPort** (layer `execution`). Tier: prototype only.

Keeps the journal of each run in memory. A run resumes while the process lives; a restart loses everything, so the
production readiness gate refuses this adapter.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxRuns` | integer | `1000` | Runs kept; ended runs are dropped oldest first |

## Behaviour

| Operation | Behaviour |
|---|---|
| `begin(runKey)` | New run, or the existing run with that key (also one that ended `waiting`); its last status stays until `end`. Holds the run so `maxRuns` never drops it, but never refuses a `begin`: one invocation per run is the core's to ensure, and the journal lives in one process |
| `step(name, fn)` | Runs `fn` once; later calls return the stored result. A throwing `fn` stores nothing. Concurrent calls share one run |
| `wait(name, untilAt)` | Resolves with the value given by `signal`, or `undefined` at `untilAt`; the result is stored. The timer does not keep the process alive |
| `signal(runKey, name, value)` | Releases the waiters of `name`; a signal that comes first is kept for the next wait. First wins: `true` when kept or delivered, `false` when `name` was already signalled or its wait settled. Unknown run: error |
| `put(text)` / `read(key)` | Key is `<runKey>:t<n>`; texts stay readable after the run ended |
| `end(status)` | Marks the run ended, lets go of the hold and applies `maxRuns` |
| `release()` | Lets go of the hold; the status stays what it was |

Step results and signal values are cloned through JSON on the way in and out, so a replay returns exactly what a
resume would; a value with no JSON form fails the step.

## Limits

| Limit | Default | Why |
|---|---|---|
| `options.maxRuns` | 1000 | Memory held by stored steps and texts |

Runs in progress and held runs are never dropped, so the count can exceed `maxRuns` while they run. A run that ended `waiting` is
dropped last among the ended ones, since it may still resume.
