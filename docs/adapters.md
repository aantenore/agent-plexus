# Adapters

Every implementation is an adapter: a package `@agent-plexus/adapter-<name>` that maps a framework, a protocol or a
technology onto a port. Adapters are independent packages, so each can have its own maintainer and release cadence.
How to write one: [guide.md](guide.md#write-an-adapter) and [CONTRIBUTING.md](../CONTRIBUTING.md).

## Maturity

| Level | Criteria |
|---|---|
| experimental | Descriptor and tests pass. Behaviour may change. |
| beta | Port conformance suite passing in CI (suites are planned), a pinned upstream version with a live contract test where there is an upstream, an owner. |
| stable | Beta for at least one minor release of its port without breaking changes, documented options, used in a reference setup. |

## Catalog

Tiers: **prototype** adapters are for laptops, tests and demos; **production** adapters can run in production. The
readiness gate (`agent-plexus check --profile <p>`) rejects prototype-only adapters on production-tier profiles. Every
adapter below is at maturity **experimental**; ports are at version 0.1.0.

Status words: **implemented** is in this repository with its tests. **Planned** is work on the order of work: the
adapters in the Planned table below, the `handoff`, `supervise` and `graph` kinds, the conformance package, the JSON
Schemas and the CLI commands `diff` and `draw`. A **candidate** is a technology worth an adapter, with no work scheduled.

### Available

Every package has its own README with options, behaviour and limits.

#### Member plane

| Layer | Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|---|
| `member` | [`function-member`](../adapters/function-member) | MemberPort | technology: in-process function | prototype, production | implemented | experimental |
| `member` | [`agent-layers`](../adapters/agent-layers) | MemberPort | technology: agent-layers stack | prototype, production | implemented | experimental |
| `member` | [`a2a-member`](../adapters/a2a-member) | MemberPort | standard: Agent2Agent (A2A) 1.0 and 0.3, JSON-RPC binding (official JavaScript SDK) | prototype, production | implemented | experimental |

#### Discovery plane

| Layer | Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|---|
| `registry` | [`static-registry`](../adapters/static-registry) | RegistryPort | technology: static member list | prototype, production | implemented | experimental |
| `routing` | [`skill-router`](../adapters/skill-router) | AgentRouterPort | technology: rules on regular expressions, tags and skills | prototype, production | implemented | experimental |

#### Flow plane

| Layer | Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|---|
| `topology` | [`basic-topology`](../adapters/basic-topology) | TopologyPort | technology: in-process topology executor (`sequence`, `route`, `loop`, `parallel`) | prototype, production | implemented | experimental |
| `execution` | [`memory-execution`](../adapters/memory-execution) | ExecutionPort | technology: in-process memory | prototype | implemented | experimental |

#### Insight plane

| Layer | Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|---|
| `attribution` | [`rule-attribution`](../adapters/rule-attribution) | AttributionPort | technology: deterministic rules on hop records | prototype, production | implemented | experimental |

#### Host

| Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|
| [`agent-layers`](../adapters/agent-layers) | Host | technology: agent-layers stack | prototype, production | implemented | experimental |
| [`agent-layers/runtime`](../adapters/agent-layers) | an agent-layers RuntimePort (plugin of an agent-layers config) | technology: agent-plexus system | prototype, production | implemented | experimental |

The `agent-layers` package (`@agent-plexus/adapter-agent-layers`) is the only one that depends on agent-layers. It has
three descriptors:

- the host `agent-layers`: `gate` from the stack's authorization, approval, credentials and guards, `telemetry`, and
  `score`. It provides no `state`: agent-layers' StatePort is an append-only event log per session, not a key/value
  store;
- the member `agent-layers`: an agent of a stack, in process. Deadline, hops and budget are not passed on yet, because
  agent-layers has no bounds;
- the runtime plugin `agent-plexus`: an agent-layers RuntimePort that runs a system. An agent-layers config loads it
  through `plugins` (`@agent-plexus/adapter-agent-layers/runtime`), not agent-plexus, so it is a separate entry point.

8 adapters in 7 packages, plus the runtime plugin.

### Planned

| Adapter | Fills | Layer | Maps | Status | Notes |
|---|---|---|---|---|---|
| `model-router` | AgentRouterPort | routing | technology: a model chooses among names and descriptions | planned | Any OpenAI-compatible endpoint, or a stack's governed model through `agent-layers` |
| `knowledge-router` | AgentRouterPort | routing | technology: a search backend ranks entries | planned | Any agent-layers knowledge source through `agent-layers` |
| `sqlite-execution` | ExecutionPort | execution | technology: SQLite through `node:sqlite` | planned | |
| `host-execution` | ExecutionPort | execution | technology: the host's `state` hook | planned | |
| `judge-attribution` | AttributionPort | attribution | technology: a model reads the hop record | planned | Agent level only |
| `replay-attribution` | AttributionPort | attribution | technology: offline counterfactual replay | planned | One member's output replaced, or one member swapped |
| `basic-topology`: `handoff`, `supervise`, `graph` | TopologyPort | topology | technology: in-process topology executor | planned | `bind` rejects these kinds today |
| `agent-layers`: tool source of `supervise` | — | member | technology: agent-layers stack | planned | The stack's tools as what a supervisor can call; needs the `supervise` kind |

### Candidates

No work is scheduled for these.

| Technology | Would fill | Layer |
|---|---|---|
| DBOS, Temporal, Hatchet | ExecutionPort (production) | execution |
| AGNTCY Agent Directory, Kubernetes CRDs | RegistryPort | registry |
| LangGraph.js, ADK-TS, Strands TS | TopologyPort | topology |
| Langfuse, Jaeger | record sources for attribution | attribution |

Sources and licenses: [research/landscape.md](research/landscape.md).

Frameworks that serve A2A (LangGraph, CrewAI, ADK, Microsoft Agent Framework, Strands, Pydantic AI) need no adapter of
their own: they join as members through `a2a-member`, which is tested against a real agent-layers stack served by its
gateway.
