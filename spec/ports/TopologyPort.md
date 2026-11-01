# TopologyPort

Layer: `topology` (L3 Topology) · Version: 0.1.0 · Conformance: planned

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
| `limits` | `{maxParallel, maxIterations, maxHandoffs}` | Numbers; `Infinity` when a limit is unbounded. |
| `call(member, input, options) → CallOutcome` | | The `memberCall` pipeline. The only way to a member. |
| `route(request) → RouteDecision` | | The AgentRouterPort over registry candidates. |
| `matches(condition, result) → Boolean` | | Evaluates a `Condition`. |
| `abandon(hopId)` | | Marks the hop of a cancelled branch, so attribution skips it. |

`CallOptions` is `{node, parentHopId?, share?, signal?, route?}`: the topology path of the calling node, the fraction of
the remaining budget to reserve (parallel branches; default all that is not reserved), a cancellation signal, and the
router's decision that chose the member. `CallOutcome` is `{hopId, result}`. `RouteRequest` is
`{input, candidates, router?, node}`.

## Semantics

- Members are reached only through `scope.call`; routers only through `scope.route`.
- The core enforces `maxSteps`, the run deadline, hops and back-and-forth (`maxRepeats`) inside `call`; the adapter
  enforces `maxParallel`, `maxIterations` and `maxHandoffs` from `scope.limits` or the node's own bound.
- `bind` rejects a spec that uses a kind it does not run, naming the kind and its path.
- A `sequence` stops at the first step that is not `completed` and returns its result.
- Node paths used in hop records: `root`, `root.steps[i]`, `root.branches[i]`, `root.merge`, `root.fallback`,
  `root.body#<iteration>` (iterations count from 1).
- The core wraps the result into a `SystemResult` with the hop record, sorted by start time.

## Errors

A topology problem is a result: `stopped` with `limit`, `rejected` or the member's own code. An adapter that throws is
turned into `failed` with code `error`, layer `topology`. A spec the adapter cannot bind makes `check` fail.

## Escape hatch

`TopologySpec.ext` carries adapter-specific node settings under `<adapter>.<name>` keys.

## Conformance

A `checkTopology` suite is planned. It will verify: `kinds` is non-empty; `bind` rejects unsupported kinds; a member is
reached only through `scope.call`; bounds are honoured; hop paths follow the node path rules.

## Version history

- 0.1.0: initial.
