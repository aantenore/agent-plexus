# agent-plexus

agent-plexus composes agents into a multi-agent system. It owns only what lies between agents: how an agent is
called, which agents exist, which one handles a request, how work flows, how a long run survives, and which agent
caused a failure. Control and insight (identity, policy, content checks, telemetry, scoring, network exposure) come
from a host through a few hooks; [agent-layers](https://github.com/aantenore/agent-layers) is the reference host,
through one adapter. The core depends on nothing and runs offline alone; agents built with any framework join over
A2A.

| Plane | L | Layer (id) | The question it answers |
|---|---|---|---|
| Member | L0 | Members (`member`) | Who does the work, and how is it called? |
| Discovery | L1 | Registry (`registry`) | Which agents exist, what can they do, can their cards be trusted? |
| Discovery | L2 | Routing (`routing`) | Which agent should handle this request? |
| Flow | L3 | Topology (`topology`) | In what order and shape does work flow between agents? |
| Flow | L4 | Execution (`execution`) | Does a long run survive a restart, and wait for a person? |
| Insight | L5 | Attribution (`attribution`) | When the system fails, which agent and which layer caused it? |

Status: design. No code yet.

- **Design:** [docs/design.md](docs/design.md)
- **What exists and what this project adopts:** [docs/research/landscape.md](docs/research/landscape.md)
- **Primitives proposed for agent-layers:** [docs/proposals/agent-layers-delegation-bounds.md](docs/proposals/agent-layers-delegation-bounds.md)
- **Decisions:** [docs/decisions/](docs/decisions/README.md)

## License

MIT. See [LICENSE](LICENSE).
