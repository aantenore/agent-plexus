# Ports

A port is the contract between the system and one kind of implementation. Every port has one page with the same
sections: Purpose, Operations, Data shapes, Semantics, Errors, Escape hatch, Conformance, Version history.

## Port index

| Plane | Layer | Port | Version | Description |
| --- | --- | --- | --- | --- |
| Member | `member` (L0) | [MemberPort](MemberPort.md) | 0.1.0 | Describe an agent and call it |
| Discovery | `registry` (L1) | [RegistryPort](RegistryPort.md) | 0.1.0 | List agents and their trust |
| Discovery | `routing` (L2) | [AgentRouterPort](AgentRouterPort.md) | 0.1.0 | Pick the agent for a request |
| Flow | `topology` (L3) | [TopologyPort](TopologyPort.md) | 0.1.0 | Run a topology of members |
| Flow | `execution` (L4) | [ExecutionPort](ExecutionPort.md) | 0.1.0 | Journal of a run: steps that run once, waits, stored texts |
| Insight | `attribution` (L5) | [AttributionPort](AttributionPort.md) | 0.1.0 | Name the layer and the member behind a failure |

The versions are the values of `PORT_VERSIONS` in `packages/core/src/ports.ts`. An adapter declares the version it
implements (`portVersion`); the core loads it only when that version is compatible with its own: same major and, while
the major is `0`, same minor. A breaking change to a port bumps the minor while the port is `0.x`, the major after. Layer ids (`member`, `registry`, ...) are
the stable identifiers. The `L0`-`L5` numbers are for reading only and never appear in identifiers or file names. The
[host hooks](../hooks.md) are not ports.

Where the boundary between layers is unclear, use these rules:

- How one agent is reached is member; choosing it is routing.
- The order of calls is topology; surviving restarts is execution.
- Whether a call may happen, what may cross, what is traced and how a run scores belong to the host.

## Notation

- `name(param: Type, ...) → Type` is an operation. A trailing `?` marks an optional parameter, field or result. `[T]` is
  a list, `{K: V}` a map, `Any` any JSON value.
- Operations that can do I/O are asynchronous: they return a result later and may fail later. A language binding picks
  its own mechanism (promise, future, blocking call).
- `signal` is a cancellation signal. When it fires, the operation stops as soon as it can.
- Data shapes are JSON values. Field names are as written, case included.
- Time is a string in date-time form, or a duration in milliseconds named `…Ms`.

## Language

The data that crosses a port is written in one small language owned by this project, version 0.1: fixed shapes,
vocabularies, and `ext` for what the shapes do not cover. Protocols (A2A, MCP, OpenAI-compatible, ...) appear only
inside adapters, which translate at the edges. See [the language](../language.md) for naming rules, shapes,
vocabularies, `ext`, `Condition` and `TopologySpec`.

## Common types

Every port instance may expose these members, whatever the port:

| Member | Meaning |
| --- | --- |
| `name: String` | Instance name: the member id for members, the port key (`registry`, `topology`, a router name) otherwise. |
| `native?() → Any` | Escape hatch for operations: the underlying client or technology-specific API (MemberPort). |
| `close?() → ()` | Release connections and flush buffers. Called once when the system closes. |

`RunContext` is passed to the ports that act inside a run (AgentRouterPort, and MemberPort through `MemberCallContext`):

| Field | Type | Meaning |
| --- | --- | --- |
| `runId` | String | Identifier of the run. |
| `system` | String | Name of the system. |
| `caller?` | Caller | Who the run acts for, as the host verified it. Absent means anonymous. Its `credential` never reaches a port. |
| `bounds?` | Bounds | Deadline, hops and budget the host passed in. |
| `lineage?` | `{rootRunId, parentRunId}` | The run that started this one, when it was started by another system. |
| `sessionId?` | String | Session the run belongs to. |
| `signal?` | Signal | Cancellation. |
| `trace?` | `{parent: String, state?: String}` | Trace context of the request that started the run. Opaque to the core. |

`MemberCallContext` is a `RunContext` plus what one member call carries:

| Field | Type | Meaning |
| --- | --- | --- |
| `hopId` | String | Identifier of this call; the key of its hop record. |
| `credential?` | String | Token for the member's audience, from the host's gate. Never the caller's own. |
| `outbound` | OutboundBounds | What crosses to the member: remaining time, hops, reserved budget, lineage. |

`RunScope` is passed to a topology for one run; its fields are on [TopologyPort](TopologyPort.md#runscope).

## Composition

The system wires the ports around each other. Adapters implement a single port and do not need to know this, but the
rules below hold for every system.

- Member call, in order: system limits and received bounds, the host's `allow`, `check` on `send`, `token`, the call as
  a journal step, `check` on `receive`, settle and record. See [the pipeline](../../docs/architecture.md#the-membercall-pipeline).
- A topology reaches members only through `scope.call`. It reaches routers only through `scope.route`.
- Refusals and failures are results (`status`, `reason.code`), never exceptions. A member that throws is `failed`.
- Every member call writes a hop record; a route that chose nobody writes one too.
- Every span, event and metric carries `plexus.layer`; the core names its own with `plexus.*` only.

## Conformance

[`@agent-plexus/conformance`](../../packages/conformance) has one suite per port and one for the host hooks:
`checkExecution`, `checkTopology`, `checkMember`, `checkRegistry`, `checkRouter`, `checkAttribution` and `checkHost`.
`checkAdapter(descriptor, { options, fixtures })` checks the descriptor, creates the adapter as `assemble` does and runs
the suite of what it fills; `checkSystem` runs the adapter inside an assembled system. Each failure starts with the id
of the rule it breaks (`E3`, `T6`, `M4`, ...), listed in the package README. Every adapter in this repository runs them
in `test/conformance.test.ts`.
