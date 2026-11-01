# Members

Layer id `member` (L0), Member plane. *Who does the work, and how is it called?*

## Responsibility

Describe one agent and call it. A member is any agent that can take an input and return a result: a function, an
agent served over a protocol, a whole agent stack, another agent-plexus system. The member owns its loop; this layer
owns only the call.

## Ports

| Port | What it does |
|---|---|
| [MemberPort](../../spec/ports/MemberPort.md) | `describe` the member as an `AgentEntry`; `invoke` it with an input and a call context; optional `resume` (continue remote work), `cancel` and `native` |

Data shapes: `AgentEntry`, `MemberResult`, `RunInput` and `Bounds` in [spec/language.md](../../spec/language.md).

One MemberPort instance exists per configured member. The call context is the run context plus the hop id, the
credential from the host's gate for the member's audience, the outbound bounds (time left, hops, reserved budget,
lineage) and `checkpoint(taskRef)`. A result has a `status` (`completed`, `failed`, `stopped`, `waiting`), an `output`, and a structured `reason`
when it did not complete; consumers branch on `reason.code` only.

### Where it sits

```mermaid
flowchart LR
  topology["L3 topology"]:::agent -->|"scope.call"| mc["memberCall"]:::external
  mc --> gate["host gate<br/>allow, token, check"]:::control
  mc --> execution["L4 execution<br/>journal step"]:::agent
  execution --> mp
  subgraph sg["L0 member"]
    mp["MemberPort<br/>describe, invoke"]:::foundation
  end
  mp --> back["function, agent-layers stack,<br/>A2A agent"]:::external
  mc -.->|"plexus.hop span"| telemetry["host telemetry"]:::insight
  classDef foundation fill:#d9dde3,stroke:#57606a,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Standards

Mapped by adapters, not by the port:

- A2A 1.0, and 0.3 through the SDK, for agents in any framework (adapter `a2a-member`, JSON-RPC binding).
- The agent-layers stack, in process (adapter `agent-layers`).

## Boundaries

- Members are reached only through `memberCall`; a topology cannot call a port directly.
- The caller reaches the member without its credential. The member receives a token for its own audience from the
  host's gate, never the caller's.
- The audience comes from config (`audience` option), never from a card.
- Bounds reach the member as `ctx.outbound`: time as remaining milliseconds, never a clock time. A member can only
  tighten them.
- A member that throws, or returns an unknown status, becomes `failed` with code `error`; the core never rejects.
- A remote call is two-phase. The member calls `ctx.checkpoint(taskRef)` as soon as the remote side has the work; the
  core keeps the handle in the run's journal next to the step (`call:<node path>:<index>:task`). If the run is begun
  again with the same run id before the step finished, a member with `resume` is asked to wait for that task through
  `resume(taskRef, undefined, ctx)` instead of being sent the request again. A finished step replays its stored result
  and calls nobody.
- A crash between sending the request and the checkpoint can still send the request twice, so a member should
  tolerate a repeated request. A member without `resume`, or one that never checkpoints, is invoked again.
- On abort or deadline the adapter cancels the remote task itself (`a2a-member` sends `CancelTask`); the core does not
  call `cancel` yet.
- Bounds travel to a remote agent in the [bounds extension](../../spec/extensions/bounds-v1.md) of A2A: time left, hops,
  budget and lineage.

## Configuration

```json
{
  "members": {
    "billing": {
      "adapter": "function-member",
      "options": { "module": "./members/billing.ts#answer", "description": "Answers invoice questions", "tags": ["billing"], "audience": "billing" }
    }
  }
}
```

Options per adapter are in each package README. The member id is the key; it is the name used in the topology, in hop
records and in `plexus.member`.

## Telemetry

| Kind | Name |
|---|---|
| span | `plexus.hop`, with `plexus.layer` = `member`, `plexus.system`, `plexus.member`, `plexus.hop`, `plexus.node.path`, then `plexus.run.status` and `plexus.run.reason` |
| event | `plexus.parts.dropped` when an input carried `parts` that did not cross |
| event | `plexus.member.resumed` when the call continued journaled remote work through `resume` (no content) |
| event | `plexus.checkpoint.ignored` when a member checkpointed a handle that is not a non-empty string of at most 1024 characters |
| metric | `plexus.hops` by member and status |

## Evaluation

A case can set an expectation per member: `expected.members.<id>` with `status`, `contains` or `matches` on the last
hop of that member. A failed expectation attributes to layer `member`. See [attribution](attribution.md).

## How to swap

Change the member's `adapter` and options. The topology, the router rules and the tests stay. A framework that serves
A2A needs no adapter of its own.

## Reference adapters

| Adapter | Maps | Status |
|---|---|---|
| [`function-member`](../../adapters/function-member) | An in-process function (prototype, production) | implemented |
| [`a2a-member`](../../adapters/a2a-member) | An agent served over A2A 1.0 and 0.3, on the official JavaScript SDK (prototype, production); card fetched without credential and verified against configured keys, endpoint pinning, https and private-address rules, polling, resume, cancel, bounds extension | implemented |
| [`agent-layers`](../../adapters/agent-layers) | An agent of an agent-layers stack, in process (prototype, production); deadline, hops and budget are not passed on yet, because agent-layers has no bounds | implemented |
| `agent-layers`: tool source of `supervise` | The stack's tools as what a supervisor can call | planned |

Another agent-plexus system as a member works in process through the `fn` option of `function-member` (code only, not
JSON config): a function that runs the other system and returns its `SystemResult`, which extends `MemberResult`. Over
the network it is an agent served over A2A, called through `a2a-member`. `a2a-member` is tested against a real
agent-layers stack served by its gateway. How to call a remote agent: [guide](../guide.md#call-a-remote-agent).

Full list: [adapters.md](../adapters.md).

## Reference setup

[`examples/offline`](../../examples/offline/README.md) has three function members: `triage`, `billing`, `manuals`.
