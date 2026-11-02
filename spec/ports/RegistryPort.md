# RegistryPort

Layer: `registry` (L1 Registry) · Version: 0.1.0 · Conformance: [`checkRegistry`](../../packages/conformance) in `@agent-plexus/conformance`

## Purpose

List the agents of a system, what they can do and how far they can be trusted. The registry answers questions about
candidates; it does not choose among them.

## Operations

- `list(filter?: CandidateFilter) → [AgentEntry]`
  Entries that match the filter; all entries without one.
- `get(id: String) → AgentEntry?`
  One entry by member id; absent when unknown.

A `watch` operation for changes is planned.

## Data shapes

`AgentEntry`, `Skill` and `CandidateFilter` are in [the language](../language.md#agententry).

## Semantics

- A filter matches an entry when each field it sets holds: `skills` when any listed id is one of the entry's skill ids;
  `tags` when every listed tag appears in some skill; `attrs` when every key is equal (a list on the filter means any
  of; a list on the entry matches if it contains the value). An empty list is no constraint.
- Entries reflect the members as assembled. `audience` comes from config, never from a card.
- `trust` says whether the card is signed and whether the endpoint is pinned in config. With `registry.requireSigned`,
  `check` fails a member that is neither.
- Cards are untrusted input. An adapter that fetches them checks signatures against configured keys and bounds the
  size and lifetime of a card with its own options and limits; the core declares no card limit.
- A `route` or `handoff` node needs a registry: `check` fails a topology that has one and no `ports.registry`.
- A `route` node with a list of ids reads each with `get` (unknown ids are dropped); with a filter it reads `list`. The
  core cuts the result at `limits.router.maxCandidates`.

## Errors

Operations reject for transport or parsing problems. A route whose candidates cannot be read is a route that chose no
member.

## Escape hatch

`AgentEntry.ext` carries registry-specific fields (a directory's skill taxonomy) under `<adapter>.<name>` keys.

## Conformance

`checkRegistry` in [`@agent-plexus/conformance`](../../packages/conformance) checks this port: rules R1-R5. Among them: `list` and `get` agree; filters behave as above; entries carry a `trust` object; `ext` keys are namespaced. The package README lists all the rules.

## Version history

- 0.1.0: initial.
