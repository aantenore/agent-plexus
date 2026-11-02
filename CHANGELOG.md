# Changelog

Every package under `packages/*` is released with the same version. See [RELEASING.md](RELEASING.md).

## 0.2.0 - unreleased

### Changed (breaking)

- The reference adapters are one package, `@agent-plexus/adapters`, one subpath export each, instead of nine
  packages: a release publishes four packages (`core`, `cli`, `conformance`, `adapters`). A config that names an
  adapter by name (`"adapter": "skill-router"`) needs no change: the core now loads `@agent-plexus/adapters/<name>`.
  Imports and `plugins` entries move as in the table. A name the package does not export fails with
  `is not one of @agent-plexus/adapters`.
- Libraries of single adapters are optional peer dependencies of `@agent-plexus/adapters`: install `@a2a-js/sdk` for
  `a2a-member` and `@agent-layers/core` (^0.4.0) for `agent-layers`. An adapter whose library is missing fails to load
  with `needs the package <name>`.
- The adapter template moved to `examples/adapter-template` (`@agent-plexus/example-adapter-template`, private).

| 0.1.0 | 0.2.0 |
|---|---|
| `@agent-plexus/adapter-a2a-member` | `@agent-plexus/adapters/a2a-member` |
| `@agent-plexus/adapter-agent-layers` | `@agent-plexus/adapters/agent-layers` |
| `@agent-plexus/adapter-agent-layers/runtime` | `@agent-plexus/adapters/agent-layers/runtime` |
| `@agent-plexus/adapter-basic-topology` | `@agent-plexus/adapters/basic-topology` |
| `@agent-plexus/adapter-function-member` | `@agent-plexus/adapters/function-member` |
| `@agent-plexus/adapter-memory-execution` | `@agent-plexus/adapters/memory-execution` |
| `@agent-plexus/adapter-rule-attribution` | `@agent-plexus/adapters/rule-attribution` |
| `@agent-plexus/adapter-skill-router` | `@agent-plexus/adapters/skill-router` |
| `@agent-plexus/adapter-sqlite-execution` | `@agent-plexus/adapters/sqlite-execution` |
| `@agent-plexus/adapter-static-registry` | `@agent-plexus/adapters/static-registry` |

The agent-layers adapters the tests and examples use follow the same layout in agent-layers 0.4.0:
`@agent-layers/adapter-<name>` is `@agent-layers/adapters/<name>`.

### Added

- `agent-layers` maps delegation, actors, approvals and state between agent-plexus and an agent-layers stack: the
  outbound bounds become the stack run's `delegation` (deadline, hops, budget, lineage) and a stack run's bounds become
  the system run's; the caller's `actors` (with `issuer`) map both ways; a waiting stack run keeps its approval under
  `ext["agent-layers.approval"]`; the host's `state` uses the stack's StorePort under `plexus.<key>`.
- `agent-layers` member: `resume` and `cancel` through the stack's run control (agent-layers 0.4.0 on). A waiting stack
  run's id is the result's `taskRef`; `resume` continues it with the answer, `cancel` withdraws it.
- `a2a-member` sends the bounds extension under its canonical agent-layers URI (`boundsUri: "plexus"` for the alias)
  and reads a bounds stop (`timeout`, `limit`, `hop_limit`) from the remote report.
- `scripts/publish-unpublished.mjs --pause=<seconds>` waits between publishes.

### Earlier in 0.2.0

- Conformance kit `@agent-plexus/conformance`, core-owned composition rules, plugins resolved from the config
  directory, `supervise` in `basic-topology`, CLI exit 3 for a waiting run, `sqlite-execution`, waiting runs that
  resume, signed-card policy, `handoff` and `graph`.

## 0.1.0

First release of `@agent-plexus/core`, `@agent-plexus/cli` and the `@agent-plexus/adapter-*` packages.
