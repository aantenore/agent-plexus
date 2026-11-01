# Swap example

The offline support system, with every layer replaceable by one line of config. The base profile uses the reference
adapters, as [examples/offline](../offline/README.md) does. Each `swap-*` profile replaces one layer with an alternative
implementation that lives in this example, loaded by path, and the system keeps working: same routes, same answers,
same attribution of the crash case.

It proves the claim of the architecture: a layer is a port plus a config key, never a dependency of the core or of the
other layers.

## What it shows

| Profile | Layer | Swapped | Result |
|---|---|---|---|
| (base) | all | `function-member`, `static-registry`, `skill-router`, `basic-topology`, `memory-execution`, `rule-attribution` | Two cases pass; the crash case fails, attributed to layer `member`, member `billing` |
| `swap-registry` | L1 registry | `static-registry` -> `./adapters/file-registry.ts`: agents read from `registry.json` | Same |
| `swap-routing` | L2 routing | `skill-router` -> `./adapters/keyword-router.ts`: keyword overlap between the input and each entry's description and skill tags, best above a threshold | Same |
| `swap-topology` | L3 topology | `basic-topology` -> `./adapters/linear-topology.ts`: runs `sequence` and `route` only | Same |
| `swap-execution` | L4 execution | `memory-execution` -> `./adapters/file-execution.ts`: the journal in JSON files under a temp dir; a new instance on the same directory replays stored steps | Same |
| `swap-attribution` | L5 attribution | `rule-attribution` -> `./adapters/last-failure-attribution.ts`: blames the member of the last hop that did not complete | Same layer and member, one rule and a fixed confidence |
| `swap-member` | L0 member | `billing` calls `./members/billing-v2.ts` (a rule table) instead of `./members/billing.ts` | Same |
| `swap-member-agent-layers` | L0 member | `billing` is served by an agent-layers stack (`./agent-layers/billing.json`: `mock-model` scripted with the three answers, `basic-runtime`, a `regex-guard` that blocks "crash") through the `agent-layers` member adapter | Same routes and answers; the crash case still fails, but as `guard_block` of the stack, attributed to the member upstream (`triage`) |
| `swap-host` | host | The prototype host -> the `agent-layers` host adapter over `./agent-layers/host.json`: `static-identity`, `rules-authorization` (allows `triage`, `billing`, `manuals`), `regex-guard` on `tool_args`, `mock-model`, `basic-runtime`, `expected-eval` | Same; a member the rules do not allow is stopped by the host (`denied`, attributed to layer `host`) |
| `swap-all` | all | The six swaps (registry, routing, topology, execution, attribution, member) together | Same |
| `unsupported-kind` | L3 topology | `linear-topology` with a `loop` topology | `check` fails: the adapter does not run `loop` |

Each swap profile is one value in `plexus.json`, for example:

```json
"swap-routing": { "ports": { "router": { "adapter": "./adapters/keyword-router.ts" } } }
```

`swap-member-agent-layers` and `swap-host` are one value as well, a whole member entry and the `host` entry: they name
the `agent-layers` adapter of `@agent-plexus/adapter-agent-layers` and a config of the agent-layers stack. Their
adapters are the published `@agent-layers/adapter-*` packages; nothing is written for them in this example.

Naming a different adapter replaces the base entry, options included, so the new adapter starts from its own defaults.
The alternatives therefore need no options: `file-registry` reads `./registry.json`, `keyword-router` needs one shared
word, `file-execution` makes a temp directory and removes it on close.

The `adapters/` files are what a third party writes: each exports `adapters`, an array of descriptors made with
`defineAdapter`, and imports only `@agent-plexus/core`. None wraps a reference adapter. `file-execution` is tier
`prototype` only, so the readiness gate refuses it on a production tier.

## Commands

From the repository root, once per profile (`<p>` is one of the profiles above; leave out `--profile` for the base):

```sh
node --conditions=@agent-plexus/source packages/cli/src/cli.ts eval examples/swap/cases.json --config examples/swap/plexus.json --profile <p>

# the unsupported topology kind is refused before any run (exit 1)
node --conditions=@agent-plexus/source packages/cli/src/cli.ts check --config examples/swap/plexus.json --profile unsupported-kind
```

Every `eval` prints `eval: 2 passed, 1 failed` and exits 1, because the third case is the crash case, meant to fail.
Its `attribution` line names member `billing` in every profile, only the evidence and the confidence differ; except
`swap-member-agent-layers`, where the billing agent stops on "crash" through a guard of its own stack. The reference
attribution blames a guard block on the member whose output was blocked, or else on the member upstream of the hop, so
the line names `triage`. The scores of `swap-host` come from the stack's `expected-eval` (output text only), not from the
prototype host.

## Test

```sh
node --conditions=@agent-plexus/source --test "examples/swap/test/**/*.test.ts"
```

For the base and each swap profile: `check` has no FAIL, the billing and product cases complete and route to the same
members as the base, and the crash case fails with attribution naming `billing` (`triage` for `swap-member-agent-layers`,
see above). Besides: a member the `swap-host` rules do not allow is stopped by the host with attribution layer `host`; the unsupported kind fails
`check`; `file-execution` replays a stored step on a second `begin` with the same run key; and the resolved config of
each profile differs from the base in exactly one adapter (or one member option), written as one value.
