# The system on one page

A multi-agent system needs six layers between its agents. agent-plexus names them, gives each one a port and composes
adapters for them from a config. The core is technology neutral: every framework or protocol below is an adapter, and
each can be swapped by changing one line of config. The design is in [architecture.md](architecture.md).

## Layers by plane

| Plane | L | Layer (id) | The question it answers | Port | Reference adapters |
|---|---|---|---|---|---|
| Member | L0 | [Members](layers/member.md) (`member`) | Who does the work, and how is it called? | MemberPort | `function-member`; `a2a-member` and an `agent-layers` adapter planned |
| Discovery | L1 | [Registry](layers/registry.md) (`registry`) | Which agents exist, what can they do, can their cards be trusted? | RegistryPort | `static-registry`; AGNTCY Agent Directory and Kubernetes CRDs are candidates |
| Discovery | L2 | [Routing](layers/routing.md) (`routing`) | Which agent should handle this request? | AgentRouterPort | `skill-router`; `model-router` and `knowledge-router` planned |
| Flow | L3 | [Topology](layers/topology.md) (`topology`) | In what order and shape does work flow between agents? | TopologyPort | `basic-topology` (`sequence`, `route`, `loop`, `parallel`); `handoff`, `supervise`, `graph` planned |
| Flow | L4 | [Execution](layers/execution.md) (`execution`) | Does a long run survive a restart, and wait for a person? | ExecutionPort | `memory-execution`; `sqlite-execution`, `host-execution` planned; DBOS, Temporal, Hatchet are candidates |
| Insight | L5 | [Attribution](layers/attribution.md) (`attribution`) | When the system fails, which agent and which layer caused it? | AttributionPort | `rule-attribution`; `judge-attribution`, `replay-attribution` planned |

The full catalog with status and maturity is in [adapters.md](adapters.md). Layer ids are stable; the numbers are for
reading only.

Boundary rules: how one agent is reached is `member`; choosing it is `routing`; the order of calls is `topology`;
surviving restarts is `execution`. Whether a call may happen, what may cross, what is traced and how a run scores
belong to the host.

## Planes at a glance

The member plane does the work, the discovery plane finds and chooses, the flow plane orders and keeps, the insight
plane explains failures. The host brings control and exposure.

```mermaid
flowchart TB
  subgraph hostp["Host: control, exposure and insight hooks"]
    expose["exposure<br/>gateway, planned"]:::experience
    gate["gate hook<br/>allow, token, check"]:::control
    tel["telemetry, score, state hooks"]:::insight
  end
  subgraph flw["Flow plane"]
    topology["L3 topology"]:::agent
    execution["L4 execution"]:::agent
  end
  subgraph dsc["Discovery plane"]
    registry["L1 registry"]:::model
    routing["L2 routing"]:::model
  end
  subgraph mbr["Member plane"]
    member["L0 member"]:::foundation
  end
  subgraph ins["Insight plane"]
    attribution["L5 attribution"]:::insight
  end
  expose -->|"starts a run"| flw
  gate -.->|"every member call"| mbr
  flw -->|"which agent"| dsc
  flw -->|"memberCall"| mbr
  flw -.->|"hop records"| ins
  tel -.-> ins
  classDef foundation fill:#d9dde3,stroke:#57606a,color:#1f2328
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef experience fill:#b2f2bb,stroke:#2a7a38,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
```

## Request flow

```mermaid
flowchart TB
  client([Person, app, agent, event]) --> host[host<br/>verify the caller, expose]
  host --> topology[topology]
  topology --> routing[routing]
  routing --> registry[registry]
  topology --> mc[memberCall]
  mc --> gate[host gate<br/>allow, check, token]
  mc --> execution[execution<br/>journal step]
  execution --> member[member]
  mc -.-> telemetry[host telemetry]
  member -.-> telemetry
  telemetry --> attribution[attribution]
  score[host score] -.-> attribution
  class client external
  class host,gate control
  class topology,execution agent
  class routing,registry model
  class member,mc foundation
  class telemetry,score,attribution insight
  classDef foundation fill:#d9dde3,stroke:#57606a,color:#1f2328
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

A host starts a run with the verified caller and the bounds it holds. The topology walks its nodes. A `route` node asks
the router, which reads candidates from the registry. Every member call goes through `memberCall`: the host's gate
allows, checks what is sent, mints a token for the member's audience; the call runs as a journal step; the gate checks
what comes back; a hop record is written. Telemetry names every span `plexus.*`. Attribution reads the hop records and
the host's scores.

## Ports and adapters

The core defines the ports. An adapter maps a framework, a protocol or one technology onto a port, and the system
config picks one per port.

```mermaid
flowchart LR
  config["System config<br/>one adapter per port, per profile"]:::external
  subgraph core["Core: ports"]
    mp["MemberPort"]:::foundation
    rp["RegistryPort"]:::model
    ap["AgentRouterPort"]:::model
    tp["TopologyPort"]:::agent
    ep["ExecutionPort"]:::agent
    atp["AttributionPort"]:::insight
  end
  subgraph impl["Reference adapters (implemented)"]
    fm["function-member<br/>in-process function"]:::external
    sr["static-registry<br/>member list"]:::external
    sk["skill-router<br/>rules"]:::external
    bt["basic-topology<br/>in-process executor"]:::external
    me["memory-execution<br/>in-process journal"]:::external
    ra["rule-attribution<br/>deterministic rules"]:::external
  end
  subgraph planned["Planned"]
    a2a["a2a-member<br/>A2A protocol"]:::external
    sq["sqlite-execution<br/>SQLite"]:::external
    db["DBOS, Temporal<br/>durable engines"]:::external
  end
  config -.-> core
  fm --- mp
  sr --- rp
  sk --- ap
  bt --- tp
  me --- ep
  ra --- atp
  a2a -.- mp
  sq -.- ep
  db -.- ep
  classDef foundation fill:#d9dde3,stroke:#57606a,color:#1f2328
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Where agent-plexus stops and agent-layers starts

agent-layers composes the eleven layers of one agent. agent-plexus composes agents. Where a concern already has an
agent-layers layer, agent-plexus calls a host hook instead of implementing it.

| Concern | agent-layers layer | agent-plexus |
|---|---|---|
| Verify the caller | L6 `identity` | Receives the caller already verified, in the run context |
| Authorize, approve, mint a token per audience | L6 `identity` | Calls the host's `gate.allow` and `gate.token` for every member call |
| Content checks | L7 `guardrail` | Calls the host's `gate.check` on what is sent to and received from a member |
| Deadline, budget, hops of one agent | the [proposed bounds primitives](proposals/agent-layers-delegation-bounds.md) | Honours what the host passes in, reserves per member call, passes the rest on |
| Spans, events, metrics | L9 `telemetry` | Emits `plexus.*` names through the host's telemetry hook |
| Scoring a run | L10 `eval` | Calls the host's `score` hook; adds attribution across hops |
| Network exposure | L8 `interface`, gateway | None: the host serves the system |
| Durable state of one agent | L3 `harness` StatePort | Its own journal across member calls; may store it in the host's `state` hook (planned) |
| How an agent is called, discovery, routing between agents, topology, cross-agent attribution | none | The six layers |

The agent-layers adapter (planned) is the only package that depends on agent-layers. It builds the four hooks from a
stack, offers a stack as a member, and runs a system as a stack's runtime so the gateway exposes it. The core never
names it.

## Cross-cutting concerns

| Concern | Spans | Doc |
|---|---|---|
| Security | member, registry, topology, host gate | [security.md](cross-cutting/security.md) |
| Limits | every layer | [limits.md](limits.md) |
