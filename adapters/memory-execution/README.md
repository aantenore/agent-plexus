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
| `begin(runKey)` | New run, or the existing run with that key (also one that ended `waiting`) |
| `step(name, fn)` | Runs `fn` once; later calls return the stored result. A throwing `fn` stores nothing. Concurrent calls share one run |
| `wait(name, untilAt)` | Resolves with the value given by `signal`, or `undefined` at `untilAt`; the result is stored. The timer does not keep the process alive |
| `signal(runKey, name, value)` | Releases the waiters of `name`; a signal that comes first is kept for the next wait. Unknown run: error |
| `put(text)` / `read(key)` | Key is `<runKey>:t<n>`; texts stay readable after the run ended |
| `end(status)` | Marks the run ended and applies `maxRuns` |

Step results and signal values are cloned through JSON on the way in and out, so a replay returns exactly what a
resume would; a value with no JSON form fails the step.

## Limits

| Limit | Default | Why |
|---|---|---|
| `options.maxRuns` | 1000 | Memory held by stored steps and texts |

Runs in progress are never dropped, so the count can exceed `maxRuns` while they run. A run that ended `waiting` is
dropped last among the ended ones, since it may still resume.
