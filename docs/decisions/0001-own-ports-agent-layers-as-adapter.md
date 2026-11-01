# 0001. Ten own layers; agent-layers is an adapter, not a foundation

Status: Proposed · Date: 2026-11-01 · Decided by: project owner · Supersedes: none

## Context

Multi-agent orchestration was kept out of agent-layers on purpose. The frameworks that orchestrate agents
([research/landscape.md](../research/landscape.md)) each own the loop, the state and the integrations, in one or two
languages, and none carries a deadline, a budget, a hop limit or a delegation chain across processes, or attributes a
failure to an agent across stacks. All the maintained ones can serve or call A2A.

A first draft hosted every system inside an agent-layers stack. That made agent-plexus a part of agent-layers in all
but name: it could not run, be tested or be adopted without it. agent-layers itself does not work that way: reinloop
is one adapter of its RuntimePort, and its core never names reinloop.

## Decision

1. **Ten layers, one question each, own ports.** `member`, `registry`, `routing`, `topology`, `execution`, `gate`,
   `bounds`, `entry`, `telemetry`, `eval`, in six planes, with MemberPort, RegistryPort, AgentRouterPort,
   TopologyPort, ExecutionPort, GatePort, LedgerPort, EntryPort, TelemetryPort, EvaluatorPort and AttributionPort.
2. **One owned language.** `Caller`, `Bounds`, `MemberResult`, `TopologySpec`, `AgentEntry`, `HopRecord`,
   `Attribution`, written under the same rules as the agent-layers language, defined here. Standards appear only in
   adapters.
3. **The core depends on nothing.** Every port has a zero-dependency reference implementation; a system runs offline
   with them.
4. **agent-layers is an adapter.** `@agent-plexus/adapter-agent-layers` maps a stack onto MemberPort, GatePort,
   TelemetryPort, ExecutionPort, EvaluatorPort and EntryPort, and is the only package that depends on agent-layers.
   The core never names it.
5. **One enforcement path.** Every member call goes through the core's `gatedCall` pipeline (bounds, authorization,
   approval, send check, credential, call, receive check, hop record). Adapters give decisions; they cannot skip it.
6. **Frameworks join as members over A2A.** No adapter per framework unless A2A is not an option.

## Consequences

- agent-plexus can be built, tested and adopted without agent-layers; with it, a deployment gets OIDC, OPA, AuthZEN,
  Presidio and the rest of the agent-layers controls through one adapter.
- The two projects share a pattern (ports, one language, profiles, readiness gate), not code. Shapes that mean the
  same (caller, run status, stop codes) are kept mappable one to one, by choice.
- Bounds are enforced by agent-plexus for its own calls now; members that are agent-layers stacks enforce them
  themselves once the agent-layers primitives land ([proposal](../proposals/agent-layers-delegation-bounds.md)).
- GatePort is one port with four operations (verify, allow, token, check); it may split later if an adapter needs one
  operation alone.
- Alternatives rejected: hosting inside agent-layers (dependency in the core); wrapping one framework as the
  orchestrator (it would own the loop, the state and the language); putting orchestration in agent-layers (it would
  widen a core meant to stay minimal).
