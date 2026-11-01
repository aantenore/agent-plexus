# 0001. Build on agent-layers: members are stacks, member calls are governed tool calls

Status: Proposed · Date: 2026-11-01 · Decided by: project owner · Supersedes: none

## Context

Multi-agent orchestration was kept out of agent-layers on purpose. The frameworks that orchestrate agents
([research/landscape.md](../research/landscape.md)) each own the loop, the state and the integrations, in one or two
languages, and none of them carries a deadline, a budget, a hop limit or a delegation chain across processes, or
attributes a failure to an agent across stacks. All the maintained ones can serve or call A2A.

## Decision

1. **A member is an agent, usually a whole agent-layers stack.** In process through its `RunnableAgent`, or remote
   over A2A through agent-layers' `a2a` runtime adapter. Frameworks join as members over A2A; agent-plexus has no
   adapter per framework.
2. **A system runs inside an agent-layers host stack.** The `system-runtime` adapter is the host's runtime; the
   `members` adapter is one of its tool sources. Every member call, fixed by the topology or chosen by a model, is a
   governed tool call: policy, approval, authorization, guards, a credential per member audience, telemetry.
3. **Five own ports, one own language.** TopologyPort, ExecutionPort, RegistryPort, AgentRouterPort, AttributionPort,
   speaking agent-plexus shapes (`TopologySpec`, `AgentEntry`, `HopRecord`, `Attribution`) under the agent-layers
   language rules. Engines (LangGraph.js, ADK, Strands, Temporal, DBOS, the AGNTCY directory) are adapters; a
   zero-dependency reference implementation exists for each port.
4. **Bounds belong to every agent.** Deadline, budget, hop limit and the actor chain are agent-layers primitives,
   proposed there ([proposal](../proposals/agent-layers-delegation-bounds.md)); agent-plexus adds only system-level
   limits.

## Consequences

- agent-plexus depends on `@agent-layers/core` as a peer and on nothing else in its core.
- Identity, authorization, guards and telemetry have one implementation, agent-layers'; a member call cannot bypass
  them.
- A system is an agent: the agent-layers gateway exposes it, and another system can use it as a member.
- Until the agent-layers primitives land, a member does not see the system's remaining bounds; the system enforces
  its own limits before each call.
- Alternatives rejected: wrapping one framework as the orchestrator (it would own the loop, the state and the
  language); a separate call path for members with its own checks (two enforcement paths drift); putting
  orchestration in agent-layers (it would widen a core that is meant to stay minimal).
