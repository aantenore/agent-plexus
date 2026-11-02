# @agent-plexus/cli

Command line for [agent-plexus](https://github.com/aantenore/agent-plexus): check a multi-agent system, run it,
talk to it and evaluate it against a file of cases.

```bash
npm install --save-dev @agent-plexus/cli @agent-plexus/core    # plus the adapters your plexus.json names
npx agent-plexus check                                         # load, assemble, readiness gate
npx agent-plexus run "I need a refund for my last invoice"     # output on stdout, one line per hop on stderr
npx agent-plexus eval cases.json                               # run, score and attribute each case
```

| Command | What it does |
|---|---|
| `check` | load the config, assemble the system, apply the readiness gate of the profile's tier |
| `run <text>` | one run: the output, then one line per hop (`--json`, `--quiet`) |
| `dev` | terminal loop: each line is a run, `/exit` quits (`--quiet`) |
| `eval <cases.json>` | run, score and attribute a file of cases (`--json`) |

Common options: `--config <file>` (default `plexus.json`), `--profile <name>`, `--help` (also per command). Exit codes:
`0` ok, `1` findings, failed runs or an invalid system, `2` wrong command line.
Full guide: [docs/guide.md](https://github.com/aantenore/agent-plexus/blob/main/docs/guide.md#cli).

Requires Node >= 22.18. License: MIT.
