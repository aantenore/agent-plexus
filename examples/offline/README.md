# Offline example

A support system of three function members, runnable with no network, no model and no agent runtime. It uses only the
reference adapters: `function-member`, `static-registry`, `skill-router`, `basic-topology`, `memory-execution` and
`rule-attribution`, with the prototype host.

## What it shows

| Piece | In this example |
|---|---|
| Members (L0) | `triage` restates the request, `billing` answers invoice, refund and charge questions, `manuals` answers product questions: plain functions in `members/` |
| Registry (L1) | `static-registry` tags `billing` with `billing` and `manuals` with `product` |
| Routing (L2) | `skill-router` rules: billing on `(?i)invoice\|refund\|charge`, manuals on `(?i)manual\|setup\|product` |
| Topology (L3) | `sequence [triage, route{candidates: [billing, manuals], fallback: triage}]` |
| Execution (L4) | `memory-execution` (prototype only) |
| Attribution (L5) | `rule-attribution`: `billing` stops with `error` when the input contains "crash", and the failure lands on layer `member`, member `billing`; so does an answer that misses what a case expects of `billing` |
| Readiness | Profile `production` sets tier production but keeps the prototype host and `memory-execution`, so `check` refuses it |

Limits: `maxSteps` is 10.

## Commands

From the repository root:

```sh
# a billing question: triage, then billing
node --conditions=@agent-plexus/source packages/cli/src/cli.ts run --config examples/offline/plexus.json "I need a refund for my last invoice"

# the prototype config passes; the production profile fails on the prototype host and adapter
node --conditions=@agent-plexus/source packages/cli/src/cli.ts check --config examples/offline/plexus.json
node --conditions=@agent-plexus/source packages/cli/src/cli.ts check --config examples/offline/plexus.json --profile production

# four cases: two pass; the crash case and the wrong-answer case fail and are attributed to member billing (exit code 1)
node --conditions=@agent-plexus/source packages/cli/src/cli.ts eval --config examples/offline/plexus.json examples/offline/cases.json
```

`run` prints the output on stdout and one line per hop on stderr (`<member> <status> <code?> <ms>ms`; `--quiet`
drops them, `--json` prints the whole result). `dev` takes the same config and runs each typed line.

## Test

From the repository root, against the sources:

```sh
node --conditions=@agent-plexus/source --test "examples/offline/test/**/*.test.ts"
```

A copy of this folder outside the repository is a package of its own: `npm install`, then `npm test`,
`npm run typecheck` and `npx agent-plexus check` (the CLI is a dev dependency).
