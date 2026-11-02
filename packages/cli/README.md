# @agent-plexus/cli

Command line for [agent-plexus](https://github.com/aantenore/agent-plexus): check a multi-agent system, run it,
talk to it and evaluate it against a file of cases.

```bash
npm install --save-dev @agent-plexus/cli @agent-plexus/core @agent-plexus/adapters    # plus any plugin your plexus.json names
npx agent-plexus check                                         # load, assemble, readiness gate
npx agent-plexus run "I need a refund for my last invoice"     # output on stdout, one line per hop on stderr
npx agent-plexus resume <runId> --approve                      # answer a waiting run (durable execution adapter)
npx agent-plexus eval cases.json                               # run, score and attribute each case
```

| Command | What it does |
|---|---|
| `check` | load the config, assemble the system, apply the readiness gate of the profile's tier |
| `run <text>` | one run: the output, then one line per hop (`--run-id <id>`, `--json`, `--quiet`) |
| `resume <runId>` | answer a waiting run and run it again: `--input <text>`, or `--approve` / `--deny` with `--reason <text>`, and `--wait <token>` from the waiting hint so the reply answers only that wait (`--json`, `--quiet`); needs a durable execution adapter across processes |
| `dev` | terminal loop: each line is a run, `/exit` quits (`--quiet`) |
| `eval <cases.json>` | run, score and attribute a file of cases (`--json`) |

A waiting run ends with the `resume` command that answers it: the reply its wait needs (`--input <text>`, or
`--approve | --deny`) and `--wait <token>`. With `--json` the result keeps `wait` (`{ token, kind, member }`, no texts).

`run --run-id <id>` runs under a chosen id (1 to 128 characters) instead of a generated one.

Common options: `--config <file>` (default `plexus.json`), `--profile <name>`, `--help` (also per command). Exit codes:
`0` ok, `1` findings, failed runs or an invalid system, `2` wrong command line, `3` a run (`run`, `resume`) that ended
waiting for a reply.
Full guide: [docs/guide.md](https://github.com/aantenore/agent-plexus/blob/main/docs/guide.md#cli).

Requires Node >= 22.18. License: MIT.
