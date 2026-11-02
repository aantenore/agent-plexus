# ExecutionPort

Layer: `execution` (L4 Execution) · Version: 0.1.0 · Conformance: [`checkExecution`](../../packages/conformance) in `@agent-plexus/conformance`

## Purpose

Keep the journal of a run so that a long run can survive a restart and wait for a person. Each member call is a step
that runs once and replays its stored result on resume.

## Operations

- `begin(runKey: String) → Execution`
  Start a run, or resume the existing run with that key (durable adapters; also one that ended `waiting`). `begin`
  does not change the run's last status. An adapter that is exclusive across processes holds the run for the
  invocation (see [Hold](#hold)) and rejects with an error whose `code` is `RUN_BUSY` while another live hold has it.
- `signal(runKey: String, name: String, value: Any) → Boolean`
  Release the waiters of `name` on a run; a signal that comes first is kept for the next wait. First wins: `true` when
  this signal was kept or delivered, `false` when `name` was already signalled or its wait already settled, in which
  case nothing changes. Atomic: of two concurrent signals of one name, exactly one returns `true`, also across
  processes on a shared durable store. An unknown run is an error.
- `read?(key: String) → String?`
  A stored text by key, for attribution, scoring and replay.

An `Execution` has:

- `step(name: String, fn: () → T) → T`
  Run `fn` once; on resume return its stored result. The result must be JSON-serialisable. `fn` MUST run in the
  caller's process, inside the `step` call, and MAY call `recall` and `remember` on the same run while it runs. A `fn`
  that rejects stores nothing, and the `step` rejects; the error it rejects with may be any error (a serialised or
  wrapped one is fine): the core does not read it to tell its own outcomes apart.
- `wait(name: String, untilAt: String) → Any`
  Suspend until `signal(runKey, name, value)` or `untilAt`; returns the value, or nothing at the deadline.
- `put(text: String) → String`
  Store a text and return its key.
- `remember(key: String, value: Any) → ()`
  Keep a small JSON value under a key for this run; the value is cloned through JSON and survives a restart when the
  adapter is durable. A later `remember` of the same key replaces it. `null` is a value like any other: a key kept
  as `null` recalls `null`, not nothing.
- `recall(key: String) → Any`
  The value kept under the key, cloned, or nothing. Keys of other runs are not visible.
- `end(status: runStatus) → ()`
  Mark the run ended with the status, and let go of the hold `begin` took.
- `release?() → ()`
  Let go of the hold `begin` took without ending the run: its last status stays.

## Data shapes

`runStatus` is in [the language](../language.md#vocabularies). Keys are opaque strings.

## Semantics

- The core calls `begin` with the run id, `step` once per member call (name `call:<node path>:<n>`, and
  `call:<node path>:<n>#<attempt>` for a resumed attempt of that call) and once per routing decision
  (`route:<node path>:<n>`), `put` for the text sent to and received from a member, and `end` with the final status.
  `<n>` counts the calls (or decisions) of that node path in the run, from 0, so keys do not depend on the order in
  which parallel branches finish. The topology MUST give every member call site a node path of its own, the same on
  every invocation of the run (see [TopologyPort](TopologyPort.md#semantics)): replay keys depend on it, and two call
  sites sharing a path would read each other's results.
- Only final outcomes are stored in a call's step: what the member returned, whatever its status. A call that threw,
  timed out or was aborted stores nothing, so a later invocation of the run calls the member again. Likewise a routing
  step stores only a decision: a router or registry that failed stores nothing.
- The core keeps, with `remember`: `run:owner` (the identity of the caller that started the run, `{id, kind, name?,
  actors?}`, or `null` without a caller; never its credential, roles or scopes), `run:input` (the run's input) and
  `run:lineage` when the run starts; `run:waiting` (`{key, attempt, kind, member, node}` of the call a run that ends
  `waiting` waits on, else `null`) and `run:status` (the status the run ended with) when it ends; `run:claimed` (the
  wait whose reply a resume delivered); and `<key>:attempt` (the attempt a resumed call makes and the reply it carries,
  an approval with `by`, the id of the caller that resumed); and `run:spent` (`{tokens, costUsd}`, what the run's calls
  spent over all its invocations) after every call that settles its budget. A failed write of a value the core keeps (a `run:*` key,
  a waiting member's handle `<step name>:task`) or a failed `end` or `release` is reported as the telemetry event
  `plexus.execution.write_failed` with the key (`end`, `release` for those two) and the error, never the value.
- A run whose `run:owner` or `run:input` cannot be kept when it starts does not start: `failed`, code `error`, layer
  `execution`, "run <id> could not be kept", before the topology runs, and the run ends `failed`. Otherwise anyone
  could later take its id over and replay what it did. A run started this way keeps its input when its owner runs it
  again.
- `run:waiting` is the wait the run's result names: every `waiting` result of a member call carries `wait` (`{token,
  kind, member}`, see [the language](../language.md#memberresult)), the topology passes it on, and the core keeps the
  call whose token it is. A `waiting` result that names none of the run's waits keeps the latest one, and the core
  reports the telemetry event `plexus.execution.wait_inferred`. `SystemResult.wait` is always the kept wait.
- `run` with the id of a run the journal knows (a kept `run:owner` or `run:input`) continues it: only with the same
  input (otherwise `failed`, code `error`, layer `execution`, "run <id> exists with a different input"; `run:input` is
  never replaced), and only for its owner or a caller the gate lets `resume` it.
- `System.resume` checks the reply's `wait` token, when given, against the kept `run:waiting` (`<key>#<attempt>`;
  another one fails with "run <id> waits on another step"), asks the gate `resume`, then calls `signal(runId,
  "<key>:reply:<attempt>", reply)`, then runs the topology again under the same key. The waiting call reads the reply
  with `wait`, with a deadline already passed: an adapter must return a signal that came before the wait. The core
  calls `wait` only after that signal.
- First reply wins. The invocation holds the run alone, so when `signal` returns `false` the reply was delivered by an
  earlier resume that did not finish (its process ended before it kept `run:claimed`): the core goes on with that
  reply, not the new one, and reports the telemetry event `plexus.execution.reply_kept`. After the signal the core
  keeps `run:claimed`, sets `run:waiting` and `run:status` to `null` (the run is in progress), and goes on. Should that
  invocation stop before the waiting call reads the reply (a crash, a deadline), `System.resume` finds nothing
  waiting; `run` with the same id and input continues the run, and the waiting call reads the claimed reply.
- An invocation that cannot start (the run is in progress, not waiting, waits on another step, the reply is of the
  wrong kind, the gate refused it, the input differs) changes nothing in the run: the core calls `release`, never
  `end`, so the run keeps its last status. Only a run that has kept nothing (`run:owner` and `run:input` absent, so
  this `begin` created it) ends `failed`, so the adapter may drop it.
- Inside each step the core calls `recall("<step name>:task")`, and `remember("<step name>:task", taskRef)` when the
  member checkpoints. The kept value stays after the step finishes and is read again only if the step has no stored
  result. A crash before the step result is stored therefore leaves the handle, and the next run of the same key
  continues the remote work (see [MemberPort](MemberPort.md#two-phase-call)). A failing `recall` fails the step. Once
  the core cancelled the task of a step, it keeps `null` under that key: the handle is forgotten.
- Before the host's gate, a call of a run whose budget earlier invocations spent asks whether its step has a stored
  result by calling `step(name, fn)` with a `fn` that throws: a stored result replays, otherwise `fn` throws and the
  step stores nothing, and the call stops with `limit`.
- `remember` and `recall` are separate from `step`: they are not replayed from a result, so they belong to the run
  and not to a step attempt.
- The core tells the outcome of a call that is not final (it threw, timed out or was aborted) apart by what its `fn`
  saw, not by the error `step` rejects with: an engine that serialises or wraps errors works unchanged.
- Concurrent calls of the same step share one run of the function.
- Step results and signal values are cloned through JSON, so a replay returns exactly what a resume would.
- The budget is the run's, not the invocation's: an invocation starts from the bounds of its context less the kept
  `run:spent`. A replayed step spends nothing in the invocation that replays it (the one that ran it already counted
  it in `run:spent`), and needs no budget: when earlier invocations spent the whole budget, steps still replay, and a
  call stops with `limit` only when it would reach the member. Its hop record is marked `replayed` and keeps the step's
  `usage` and `costUsd`; the result handed to the topology leaves them out, and the `usage` and `costUsd` of the
  system result are the core's totals over the records of the invocation that are not `replayed`.
- A crash after a step stores its result and before `run:spent` is written leaves that call out of `run:spent`: a
  later invocation replays it without counting it.
- Hop records carry the keys of stored texts (`inputRef`, `outputRef`), never the texts.
- A prototype adapter may lose everything on restart; the readiness gate refuses it on a production tier.

## Hold

One invocation runs a run at a time. In its own process the core refuses a `run` or `resume` of a run that another
invocation holds, before it calls `begin`: `failed`, code `error`, layer `execution`, "run <id> is in progress". The
hold is per execution adapter instance, so systems sharing one instance share it.

Across processes the adapter holds the run: `begin` takes a hold that `end`, `release` and `close` let go of. A `begin`
while another live hold has the run rejects with an error whose `code` is `RUN_BUSY` (core `RunBusyError`), and the
core answers as for a run in progress. A hold expires after a time the adapter sets, extended by every write of its
holder, so a process that crashed blocks the run only until then; once another invocation took the run over, the old
holder's writes are refused. An adapter that cannot hold across processes (memory, or a prototype on files) says so:
two processes on one store may then run one run at once.

The hold ensures a refused invocation never ends or drops a run another one is running, a `run` racing a `resume`
never writes a stale `run:waiting`, and an ended run is never dropped while it is held.

## Errors

A failing `begin` makes the run `failed` with code `error`, layer `execution` (a `RUN_BUSY` one: "run <id> is in
progress"). A failing `step` makes the call `failed` with the same layer. A failing `put`, `end` or `release` does not
change the result; `end` and `release` are reported.

## Escape hatch

`native()` is not defined for this port. Adapter-specific data goes in step results, which must be JSON.

## Conformance

`checkExecution` in [`@agent-plexus/conformance`](../../packages/conformance) checks this port: rules E1-E14. Among them: a step runs once and replays; the first signal of a name wins; `put` and `read` agree; `remember` and `recall` survive a restart; an exclusive adapter refuses a second holder with `RUN_BUSY`; `close` settles pending waits. The package README lists all the rules.

## Version history

- 0.1.0: initial; `remember`, `recall`, the hold (`RUN_BUSY`), `release` and `run:spent` added before release.
