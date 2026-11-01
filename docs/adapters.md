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

### Available

Implemented in slice 1. Every package has its own README with options, behaviour and limits.

#### Member plane

| Layer | Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|---|
| `member` | [`function-member`](../adapters/function-member) | MemberPort | technology: in-process function | prototype, production | implemented | experimental |

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

6 adapters in 6 packages.

### Planned

| Adapter | Fills | Layer | Maps | Status | Notes |
|---|---|---|---|---|---|
| `a2a-member` | MemberPort | member | standard: A2A 1.0 (official JavaScript SDK) | planned | Card pinned, endpoint rules, bounds and lineage through the A2A extension, polling, resume and cancel |
| `agent-layers` | Host, MemberPort, a stack's RuntimePort, router helpers | member, host | technology: agent-layers stack | planned | The only package that depends on agent-layers; builds the four hooks from a stack, offers a stack as a member, runs a system as a stack's runtime |
| `model-router` | AgentRouterPort | routing | technology: a model chooses among names and descriptions | planned | Any OpenAI-compatible endpoint, or a stack's governed model through `agent-layers` |
| `knowledge-router` | AgentRouterPort | routing | technology: a search backend ranks entries | planned | Any agent-layers knowledge source through `agent-layers` |
| `sqlite-execution` | ExecutionPort | execution | technology: SQLite through `node:sqlite` | planned | |
| `host-execution` | ExecutionPort | execution | technology: the host's `state` hook | planned | |
| `judge-attribution` | AttributionPort | attribution | technology: a model reads the hop record | planned | Agent level only |
| `replay-attribution` | AttributionPort | attribution | technology: offline counterfactual replay | planned | One member's output replaced, or one member swapped |
| `basic-topology`: `handoff`, `supervise`, `graph` | TopologyPort | topology | technology: in-process topology executor | planned | `bind` rejects these kinds today |

Candidates, not planned work: DBOS, Temporal and Hatchet as production ExecutionPort adapters; AGNTCY Agent Directory
and Kubernetes CRDs as RegistryPort adapters; LangGraph.js, ADK-TS and Strands TS as TopologyPort adapters; Langfuse
and Jaeger as record sources for attribution. Sources and licenses: [research/landscape.md](research/landscape.md).

Frameworks that serve A2A (LangGraph, CrewAI, ADK, Microsoft Agent Framework, Strands, Pydantic AI) need no adapter of
their own: they join as members through `a2a-member`.
