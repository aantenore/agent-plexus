# agent-plexus

agent-plexus composes agents into a multi-agent system: which agents exist, which one handles a request, how work
flows between them, what each call may do and spend, and, when the system fails, which agent and which layer caused
it.

It names ten layers, gives each its ports, and composes adapters for them from a config, per profile (prototype,
pilot, production). It implements none of them. The core depends on nothing; agents built with any framework join
over A2A, and [agent-layers](https://github.com/aantenore/agent-layers) is one adapter among others.

| Plane | L | Layer (id) | The question it answers |
|---|---|---|---|
| Member | L0 | Members (`member`) | Who does the work, and how is it called? |
| Discovery | L1 | Registry (`registry`) | Which agents exist, what can they do, can their cards be trusted? |
| Discovery | L2 | Routing (`routing`) | Which agent should handle this request? |
| Flow | L3 | Topology (`topology`) | In what order and shape does work flow between agents? |
| Flow | L4 | Execution (`execution`) | Does a long run survive a restart, and wait for a person? |
| Control | L5 | Gate (`gate`) | May this call happen, with which credential, is what crosses acceptable? |
| Control | L6 | Bounds (`bounds`) | How long, how much and how deep may the work go? |
| Experience | L7 | Entries (`entry`) | Who reaches the system, and how? |
| Insight | L8 | Telemetry (`telemetry`) | What happened? |
| Insight | L9 | Evaluation & attribution (`eval`) | Was it good, and if not, which agent and which layer failed? |

Status: design. No code yet.

- **Design:** [docs/design.md](docs/design.md)
- **What exists and what this project adopts:** [docs/research/landscape.md](docs/research/landscape.md)
- **Primitives proposed for agent-layers:** [docs/proposals/agent-layers-delegation-bounds.md](docs/proposals/agent-layers-delegation-bounds.md)
- **Decisions:** [docs/decisions/](docs/decisions/README.md)

## License

MIT. See [LICENSE](LICENSE).
