# 0001. Six layers between agents; control and insight come from a host

Status: Proposed · Date: 2026-11-01 · Decided by: project owner · Supersedes: none

## Context

Multi-agent orchestration was kept out of agent-layers on purpose. The frameworks that orchestrate agents
([research/landscape.md](../research/landscape.md)) each own the loop, the state and the integrations, and none
carries a deadline, a budget, a hop limit or a delegation chain across processes, or attributes a failure to an
agent across stacks. All the maintained ones can serve or call A2A.

Two drafts were discarded. The first hosted every system inside an agent-layers stack: agent-plexus could not run
without it. The second made agent-plexus self-sufficient with ten layers, and in doing so rebuilt agent-layers'
control and insight planes (identity, guardrails, telemetry, evaluation, interfaces) under other names: two control
planes, two languages to keep in step. agent-layers itself shows the right shape: reinloop is independent of it
because it does one thing, the loop, and receives governed tools from its host instead of implementing identity or
guardrails.

## Decision

1. **Six layers, all between agents.** `member`, `registry`, `routing`, `topology`, `execution`, `attribution`, each
   with one port and a zero-dependency reference implementation.
2. **Control and insight are host hooks.** `gate` (allow, token, check), `telemetry`, `score`, `state`, passed to
   `assemble(config, host)`. Prototype defaults exist so the core runs alone; the readiness gate refuses them on a
   production tier.
3. **One call path.** Every member call goes through the core's `memberCall` pipeline, which asks the host's gate
   before and after the call.
4. **agent-layers is the reference host, through one adapter.** `@agent-plexus/adapter-agent-layers` builds the
   hooks from a stack, offers stacks as members, and runs a system as a stack's runtime so the gateway exposes it. It
   is the only package that depends on agent-layers; the core never names it.
5. **Minimal own language.** `TopologySpec`, `AgentEntry`, `HopRecord`, `Attribution`, `RouteDecision`, plus a
   `RunContext` and `MemberResult` whose values equal agent-layers' by choice. The host's caller is carried, not
   interpreted.
6. **Bounds defined once.** The rules and the A2A extension are those of the agent-layers proposal
   ([proposal](../proposals/agent-layers-delegation-bounds.md)); agent-plexus honours them and adds only system
   limits.
7. **Frameworks join as members over A2A.**

## Consequences

- agent-plexus runs offline alone, and in production with any host that fills four hooks; nothing in agent-layers is
  duplicated.
- No network server of its own: exposure is the host's.
- Alternatives rejected: hosting inside agent-layers (dependency in the core); own control and insight layers
  (duplication); wrapping one framework as the orchestrator; putting orchestration in agent-layers.
