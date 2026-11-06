# agent-plexus starter

A support system of three function members, written by `agent-plexus init`. It runs with no network, no model and no
agent runtime: the members are plain functions in `members/`, and the reference adapters of `@agent-plexus/adapters`
fill the six layers.

| File | What it holds |
|---|---|
| `plexus.json` | The system: members, one adapter per port, the topology `sequence [triage, route{billing, manuals}]`, limits and two profiles |
| `members/*.ts` | `triage` restates the request, `billing` answers invoice and refund questions, `manuals` answers product questions |
| `cases.json` | Three eval cases: two pass, the crash case fails and is attributed to member `billing` |

## Commands

```sh
npx agent-plexus check                                         # load, assemble, readiness gate (exit 0)
npx agent-plexus run "I need a refund for my last invoice"     # the billing answer, one line per hop on stderr
npx agent-plexus check --profile production                    # exit 1: the prototype host and memory-execution
npx agent-plexus eval cases.json                               # 2 passed, 1 failed (exit 1)
npx agent-plexus dev                                           # each typed line is one run
```

The members are TypeScript files that Node runs as they are (type stripping, Node >= 22.18). They are ES modules, so
`package.json` needs `"type": "module"`, which `init` sets; without it every member fails with
`Cannot use import statement outside a module`.

Next: edit `plexus.json` and the members, or replace a member by an agent of another framework.
Guide: <https://github.com/aantenore/agent-plexus/blob/main/docs/guide.md>.
