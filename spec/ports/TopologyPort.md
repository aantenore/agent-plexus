# TopologyPort

Layer: `topology` (L3 Topology) · Version: 0.1.0 · Conformance: [`checkTopology`](../../packages/conformance) in `@agent-plexus/conformance`

## Purpose

Run a topology: the order and shape in which members are called. The topology is data (`TopologySpec`); the adapter
is the executor.

## Operations

- `kinds: [kind]`
  The topology kinds this adapter can run. `check` refuses a topology that uses others.
- `bind(spec: TopologySpec, info: TopologyInfo) → BoundTopology`
  Validate the spec and prepare an executor. May be asynchronous. `info` is `{system, members}`.
- `BoundTopology.run(input: RunInput, scope: RunScope) → MemberResult`
  Run the topology once.

## Data shapes

`TopologySpec`, `Condition`, `MemberResult` and `RunInput` are in [the language](../language.md#topologyspec).

### RunScope

What the core gives the adapter for one run.

| Field | Type | Meaning |
| --- | --- | --- |
| `ctx` | RunContext | The run context, caller without credential. |
| `input` | RunInput | The system's original input. |
| `limits` | `{maxParallel, maxIterations, maxHandoffs}` | Numbers: none of the three accepts `unbounded`. |
| `call(member, input, options) → CallOutcome` | | The `memberCall` pipeline. The only way to a member. |
| `route(request) → RouteDecision` | | The AgentRouterPort over registry candidates. |
| `matches(condition, result) → Boolean` | | Evaluates a `Condition`. |
| `abandon(hopId)` | | Marks the hop of a cancelled branch, so attribution skips it. |

`CallOptions` is `{node, parentHopId?, share?, signal?, route?}`: the topology path of the calling node, the fraction of
the budget not yet spent to reserve (default all that no other call reserved), a cancellation signal, and the router's
decision that chose the member. `CallOutcome` is `{hopId, result}`; when the call replayed from the journal, `result`
has no `usage` or `costUsd` (an earlier invocation spent them). `RouteRequest` is `{input, candidates, router?, node, optional?}`. With `optional`, choosing nobody is an
expected answer (a handoff that ends): the core writes no hop record for it. Without `optional`, a decision with no
member is a hop of its own (`stopped`, `rejected`, layer `routing`), which attribution can name. A decision with
`failed` (the router or the registry threw, or the router chose outside the candidates) always writes a hop of its
own, `failed`, code `error`, layer `routing`, also with `optional`.

## Semantics

- Members are reached only through `scope.call`; routers only through `scope.route`.
- Every member call site MUST have a node path of its own, and the same one on every invocation of the run: the
  journal keys a call `call:<node path>:<n>` (`<n>` counting the calls of that path), so a replay finds a call's
  stored result only by its path. Calls of one site in a row (a loop body, a handoff turn) may share a path; `<n>`
  tells them apart as long as they happen in the same order.
- Calls that run at the same time MUST pass `share`, and the shares of calls that run at the same time MUST sum to at
  most 1. A share is a fraction of the budget not yet spent, capped by what the other calls reserved: concurrent calls
  get the share they ask for whatever order they reserve in. `parallel` passes each branch `1/branches` of its own
  share (even shares).
- The core enforces `maxSteps`, the run deadline, hops and back-and-forth (`maxRepeats`) inside `call`, and
  `maxParallel` across the whole run: a call beyond it waits for a slot, first come first served, and is never refused
  for it; one whose signal aborts or whose deadline passes while it waits stops with `aborted` or `timeout`. The
  adapter enforces `maxIterations` and `maxHandoffs` from `scope.limits` or the node's own bound, and may bound the
  width of its own nodes by `maxParallel` too.
- `abandon(hopId)` marks the hop, and when the call ended `waiting` on a remote task its member is asked to `cancel`
  it (best effort, see [MemberPort](MemberPort.md#operations)). A call aborted through its signal has its task
  cancelled by the core already.
- `bind` rejects a spec that uses a kind it does not run, naming the kind and its path.
- A `sequence` stops at the first step that is not `completed` and returns its result.
- A `handoff` asks its router with `optional: true`: a router that chooses nobody ends the handoff `completed`, and
  leaves no routing hop that a later failure could be attributed to. A routing decision with `failed` stops the
  handoff `failed`, code `error`, layer `routing`. A `route` node whose decision failed runs its `fallback`, else ends
  `failed` the same way.
- A `handoff` is bounded by `maxHandoffs` (the node's own, else `scope.limits`); a `graph` follows the first edge from
  a node that applies, and a node visited more than `scope.limits.maxIterations` times stops with `limit`. An edge
  without `when` applies to a `completed` result; an edge's `when` applies to a `waiting` result only if its `status`
  names `waiting`, otherwise a waiting node ends the graph `waiting`.
- A `supervise` delegation counts against `scope.limits.maxHandoffs`.
- Node paths used in hop records: `root`, `root.steps[i]`, `root.branches[i]`, `root.merge`, `root.fallback`,
  `root.body#<iteration>` (iterations count from 1), `root.turns[i]` (handoff), `root.supervisor[i]` and
  `root.members[i]` (supervise, per turn), `root.nodes.<id>` (graph; `#<visit>` from the second visit).
- The core wraps the result into a `SystemResult` with the hop record, sorted by start time. Its `usage` and `costUsd`
  are the core's totals over the hop records of the invocation that are not `replayed`; what the topology's result
  carries for them is not used.

## Errors

A topology problem is a result: `stopped` with `limit`, `rejected` or the member's own code. An adapter that throws is
turned into `failed` with code `error`, layer `topology`. A spec the adapter cannot bind makes `check` fail.

## Escape hatch

`TopologySpec.ext` carries adapter-specific node settings under `<adapter>.<name>` keys.

## Conformance

`checkTopology` in [`@agent-plexus/conformance`](../../packages/conformance) checks this port: rules T1-T9. Among them: `kinds` is non-empty; `bind` rejects unsupported kinds; a member is reached only through `scope.call`; bounds are honoured; hop paths follow the node path rules. The package README lists all the rules.

## Version history

- 0.1.0: initial.
