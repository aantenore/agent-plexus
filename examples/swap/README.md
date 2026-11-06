# Swap example

The offline support system, with every layer replaceable in config only. The base profile uses the reference adapters,
as [examples/offline](../offline/README.md) does. Each `swap-*` profile replaces one layer with another implementation,
either an adapter that lives in this example, loaded by path, or another published adapter, and the system keeps
working: same routes, same answers, same member blamed for the crash case.

What it shows: a layer is a port plus a config key, not a dependency of the core or of the other layers. What it does
not show: it runs offline, in one process per command, against three cases; the A2A member talks to a fake agent the
test starts on loopback, and a resumed run is checked in the tests, not from the command line.

## What it shows

| Profile | Layer | Swapped | Result |
|---|---|---|---|
| (base) | all | `function-member`, `static-registry`, `skill-router`, `basic-topology`, `memory-execution`, `rule-attribution`, the prototype host | Two cases pass; the crash case fails, attributed to layer `member`, member `billing` |
| `swap-registry` | L1 registry | `static-registry` -> `./adapters/file-registry.ts`: agents read from `registry.json` | Same |
| `swap-routing` | L2 routing | `skill-router` -> `./adapters/keyword-router.ts`: keyword overlap between the input and each entry's description and skill tags, best above a threshold | Same |
| `swap-topology` | L3 topology | `basic-topology` -> `./adapters/linear-topology.ts`: runs `sequence` and `route` only | Same |
| `swap-execution` | L4 execution | `memory-execution` -> `./adapters/file-execution.ts`: the journal in JSON files under a temp dir; a new instance on the same directory replays stored steps | Same |
| `swap-execution-sqlite` | L4 execution | `memory-execution` -> `sqlite-execution`, the journal in the SQLite file at `SWAP_SQLITE_PATH` (default `:memory:`) | Same |
| `swap-attribution` | L5 attribution | `rule-attribution` -> `./adapters/last-failure-attribution.ts`: blames the member of the last hop that did not complete | Same layer and member, one rule and a fixed confidence |
| `swap-member` | L0 member | `billing`: `function-member` -> `./adapters/table-member.ts`, the same answers from a JSON rule table (`./members/billing.table.json`) | Same |
| `swap-member-agent-layers` | L0 member | `billing` is served by an agent-layers stack (`./agent-layers/billing.json`: `mock-model` scripted with the three answers, `basic-runtime`, a `regex-guard` that blocks "crash") through the `agent-layers` member adapter | Same routes and answers; the crash case still fails, but as `guard_block` of the stack, attributed to `billing`, as `triage` only restated the caller's input |
| `swap-member-a2a` | L0 member | `billing` is a remote agent called over A2A by `a2a-member`, at the card URL in `SWAP_BILLING_A2A_URL` | Same with the fake agent of the tests (it answers as `./members/billing.ts` and rejects the crash: `rejected`, attributed to `billing`); from the command line it needs a running A2A agent |
| `swap-host` | host | The prototype host -> the `agent-layers` host adapter over `./agent-layers/host.json`: `static-identity`, `rules-authorization` (allows `triage`, `billing`, `manuals`), `regex-guard` on `tool_args`, `mock-model`, `basic-runtime`, `expected-eval` | Same; a member the rules do not allow is stopped by the host (`denied`, attributed to layer `host`) |
| `swap-all` | all | The registry, routing, topology, file execution, attribution, `swap-member` and host swaps together | Same |
| `unsupported-kind` | L3 topology | `linear-topology` with a `loop` topology | `check` fails: the adapter does not run `loop` |

Besides the cases, a run that waits is resumed on three journals: the host's gate asks before `billing`, the run ends
`waiting`, and `System.resume` approves it; on `memory-execution` from the same system, on `file-execution` and
`sqlite-execution` from a new system on the same journal, as after a restart. The run completes and the `triage` step
replays from the journal instead of being called again.

Each port swap is one value in `plexus.json`, for example:

```json
"swap-routing": { "ports": { "router": { "adapter": "./adapters/keyword-router.ts" } } }
```

The member profiles and `swap-host` are one value as well, a whole member entry or the `host` entry. `swap-execution-sqlite`
and `swap-member-a2a` take their path and URL from the environment through `${env:...}`, so a run picks a temp file or
the address of an agent without editing the config. The adapters of `swap-execution-sqlite`, `swap-member-a2a`,
`swap-member-agent-layers` and `swap-host` are published packages; nothing is written for them in this example.

Naming a different adapter replaces the base entry, options included, so the new adapter starts from its own defaults.
The port alternatives of this example therefore need no options: `file-registry` reads `./registry.json`,
`keyword-router` needs one shared word, `file-execution` makes a temp directory and removes it on close.

The `adapters/` files are what a third party writes: each exports `adapters`, an array of descriptors made with
`defineAdapter`, and imports only `@agent-plexus/core`. None wraps a reference adapter. `file-execution` and
`table-member` are tier `prototype` only, so the readiness gate refuses them on a production tier. `file-execution` does
not hold a run across processes (no `RUN_BUSY`, no `release`): within one process the core runs one invocation per run,
but two processes on one directory may run the same run at once.

## Swap matrix

[`cells.json`](cells.json) lists the cells of the matrix: each names a profile (`null` for the base) and what is run
against it, `cases` (the three cases), `wait` (the wait and resume above) or `check-fails`. From the repository root:

```sh
npm run swap:matrix                                  # every cell
node scripts/swap-matrix.mjs --only execution-sqlite,all
node scripts/swap-matrix.mjs --list
```

For each cell it runs the tests named `cell <id>: ...` of `test/swap.test.ts`, and for a cell with `"cli": true` the
command line as a user would: `check`, then `eval` of `cases.json`, which must give 2 passed and the crash case failed,
attributed to `billing`. `SWAP_SQLITE_PATH` points at a temp file for every cell. It prints one line per cell and a
table; the exit code is 1 when a cell fails. `member-a2a` and the `wait-resume-*` cells run in the tests only.

## Commands

From the repository root, once per profile (`<p>` is one of the profiles above; leave out `--profile` for the base):

```sh
node --conditions=@agent-plexus/source packages/cli/src/cli.ts eval examples/swap/cases.json --config examples/swap/plexus.json --profile <p>

# the SQLite journal at a path of your choice
SWAP_SQLITE_PATH=/tmp/swap-journal.db node --conditions=@agent-plexus/source packages/cli/src/cli.ts eval examples/swap/cases.json --config examples/swap/plexus.json --profile swap-execution-sqlite

# the unsupported topology kind is refused before any run (exit 1)
node --conditions=@agent-plexus/source packages/cli/src/cli.ts check --config examples/swap/plexus.json --profile unsupported-kind
```

Every `eval` prints `eval: 2 passed, 1 failed` and exits 1, because the third case is the crash case, meant to fail.
`swap-member-a2a` needs `SWAP_BILLING_A2A_URL`, the card URL of a running A2A agent that answers billing questions.
Its `attribution` line names member `billing` in every profile, only the evidence and the confidence differ; except
`swap-member-agent-layers`, where the billing agent stops on "crash" through a guard of its own stack. The reference
attribution traces a guard block past members that only repeated what they received: `triage` restates the caller's input,
so the block is traced to the input and the line names `billing`. The scores of `swap-host` come from the stack's `expected-eval` (output text only), not from the
prototype host.

## Test

From the repository root, against the sources:

```sh
node --conditions=@agent-plexus/source --test "examples/swap/test/**/*.test.ts"
```

A copy of this folder outside the repository is a package of its own: `npm install`, then `npm test`,
`npm run typecheck` and `npx agent-plexus eval cases.json --profile swap-all` (the CLI is a dev dependency).

For each cell of `cells.json`: with `cases`, `check` has no FAIL, the billing and product cases complete and route to
the same members as the base, and the crash case fails with attribution naming `billing`; with `wait`, the waiting run
resumes and completes and `triage` replays; with `check-fails`, `check` names the unsupported kind. Besides: every swap
profile of `plexus.json` is in a cell; each port swap is one value and changes exactly one adapter; each member swap
replaces the `billing` entry with another member adapter and nothing else; `swap-all` is the port, member and host
swaps together; the A2A agent is called once per case that reaches `billing`; a member the `swap-host` rules do not
allow is stopped by the host with attribution layer `host`; `file-execution` replays a stored step on a second `begin`
with the same run key; `linear-topology` fails a route whose router failed in the routing layer and sums the usage and
cost of a sequence.
