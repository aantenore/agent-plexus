# AgentRouterPort

Layer: `routing` (L2 Routing) · Version: 0.1.0 · Conformance: planned

## Purpose

Choose the agent that should handle a request, among candidates. Not agent-layers' RouterPort, which picks a model.

## Operations

- `route(question: RouteQuestion, ctx: RunContext) → RouteDecision`
  Decide which candidate handles the input.

## Data shapes

`RouteQuestion` and `RouteDecision` are in [the language](../language.md#routing). `RunContext` is in the
[port index](README.md#common-types).

## Semantics

- No `member` in the decision means no candidate fits. The topology decides what follows (`fallback`, else `rejected`).
  When the topology asked with `optional` (a handoff), no member is an expected answer and no routing hop is recorded.
- `ranked` lists every applicable candidate, best first, with a score; the order is the router's own.
- The member must be one of the candidates. The core replaces a decision that names another member with a failed one
  (`failed: true`, no member).
- The router sees the caller without its `credential`, and the run's bounds. It calls nothing outside what it maps.
- `reason` is internal text, never parsed.
- Several routers may be configured under names; a `route` node picks one with `router`, default `router`.

## Errors

A router that throws (or a registry that fails to give the candidates) gives a decision with `failed: true`, no member,
and the error message as internal reason: not the same as choosing nobody. It is not journaled, so a run begun again
asks the router again; the core writes a routing hop for it (`failed`, code `error`, layer `routing`) even for an
`optional` request. Invalid options are rejected when the router is created.

## Escape hatch

`RouteDecision` has no `ext` today; router-specific data goes in the internal `reason`, which is never parsed.

## Conformance

A `checkRouter` suite is planned. It will verify: a decision names a candidate or none; `ranked` contains only
candidates; the call does not mutate the candidates.

## Version history

- 0.1.0: initial.
