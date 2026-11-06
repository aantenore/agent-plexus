# Changelog

Every package under `packages/*` is released with the same version. See [RELEASING.md](RELEASING.md).

## Unreleased

## 0.2.1 - 2026-11-06

### Fixed

- An adapter named in the config (`"adapter": "<name>"`) is loaded from the `@agent-plexus/adapters` installed next to
  the config, as `plugins` packages are, and only otherwise from the one next to the core: with `npx @agent-plexus/cli`
  or a global CLI the project's own install is found instead of `is not installed`. A copy next to the config that does
  not export the name is an error, not a fallback. The message of a missing package names both places.
- The examples run outside the repository: their `npm test` no longer passes `--conditions=@agent-plexus/source`
  (which maps to `src/`, not in the tarballs), their `tsconfig.json` no longer extends the repository's, and the CLI is
  a dev dependency of `offline` and `swap`. `npm run test:packages` keeps running every workspace against the sources.
- Published manifests no longer carry the `@agent-plexus/source` export condition: `prepack` strips it and `postpack`
  restores `package.json`.
- A text the execution adapter could not store (`put`) is reported as `plexus.execution.write_failed` with the key
  `put` instead of being dropped silently; the hop record then has no `inputRef` or `outputRef`.
- `sqlite-execution` closes the database it refuses (a newer schema version, a failed setup) and a `ROLLBACK` that
  fails no longer hides the error of the write.
- The CLI builds on Windows (`chmod` replaced by `scripts/bin-mode.mjs`).
- The README and the description of `@agent-plexus/cli` list `cancel`; the README of `@agent-plexus/adapters` links the
  adapter READMEs on GitHub, since the tarball has no `src/`.

### Added

- `agent-plexus --version` (`-v`, `version`) prints the version of `@agent-plexus/cli`.
- Ctrl-C (SIGINT) and SIGTERM stop a command cleanly: a run in progress ends `stopped`/`aborted` through its signal,
  the journal lets go of it (no `sqlite-execution` lease to wait out before a `resume`, `cancel` or `run --run-id`),
  `dev` and `eval` end after the current run, the system is closed and the exit code is 130; a second signal exits at
  once.
- `limits.system.describeTtlMs` (default 60000, 0 asks every time): how long the core keeps a member's `describe()`
  answer before asking again, so a long-running system sees a member change its card.
- The unscoped package `agent-plexus`, a stub that forwards to `@agent-plexus/cli`, so `npx agent-plexus` runs this
  project's command line.
- `agent-plexus init [dir]` writes a starter system into an empty folder: `plexus.json`, three members, `cases.json`
  and a README, copied from `examples/offline` when the CLI is built, and `"type": "module"` in `package.json` (created
  with the packages as dev dependencies when missing). `--force` writes into a folder that holds other files.
- The README and the guide start from npm (`npm install`, `npx agent-plexus init`); the guide gains a Troubleshooting
  section (missing adapters, `Cannot use import statement outside a module`, exit codes).

### Changed

- `scripts/publish-unpublished.mjs` refuses to publish a version whose tag `v<version>` is not at `HEAD`
  (`--allow-untagged` skips the check), so what npm records as `gitHead` is the tagged commit.
- The development and test dependencies on agent-layers move to 0.4.2 (`@agent-layers/core`, `adapters`, `gateway`,
  `conformance`), and `package-lock.json` is generated again: one copy of `@agent-layers/core`, no stale
  `adapters/<name>` workspace entries. The optional peer range on `@agent-layers/core` stays `^0.4.0`.

## 0.2.0 - 2026-11-03

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

The nine 0.1.0 `@agent-plexus/adapter-<name>` packages are deprecated on npm, each with a message that names its
subpath in `@agent-plexus/adapters`.

### Changed

- The core owns what composition relies on: totals from hop records, the `maxParallel` slots, the cancel of a remote
  task when the core cuts a call off, the run budget, scores of `expected` without a host scorer.
- `plugins` are resolved from the directory of the config, as an `import` written there would.
- The CLI exits with 3 when a run (`run`, `resume`) ends waiting for a reply, and `run` takes `--run-id`.

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
- `System.cancel(runId, { by?, reason?, signal? })` closes a run that is not over, such as a waiting one: the member it
  waits on is asked to cancel its remote task (best effort), and the run ends `stopped` with the new code `cancelled`,
  so it can no longer be resumed or run again. Authorized like a resume, by the host's gate with the new `cancel`
  action (`CancelQuestion`; the prototype and `agent-layers` hosts allow the owner only; `agent-layers` exports
  `CANCEL_ACTION`). Refusals carry the new codes `not_found` (unknown run) and `conflict` (the run is already over).
  `agent-plexus cancel <runId>` does the same from the command line. `GateQuestion` gains the `cancel` variant: a host
  that told `invoke` from `resume` by `action === 'resume'` should test `action === 'invoke'` instead (an unhandled
  question is a deny).

- Conformance kit `@agent-plexus/conformance`: the contract tests a port adapter runs in its own tests.
- `supervise` in `basic-topology`.

## 0.1.0 - 2026-11-02

First release of `@agent-plexus/core`, `@agent-plexus/cli` and the `@agent-plexus/adapter-*` packages, including
`sqlite-execution`, runs that end waiting and resume with a reply (`System.resume`, `agent-plexus resume`), the
signed-card policy of `static-registry` with `registry.requireListed`, and the `handoff` and `graph` nodes.
