# agent-plexus

agent-plexus composes whole agent stacks into a multi-agent system: which agents exist, how work flows between them,
which agent handles a request, and, when the system fails, which agent and which layer caused it.

It is built on [agent-layers](https://github.com/aantenore/agent-layers). agent-layers composes the eleven layers of
one agent through its own ports and swappable adapters; agent-plexus composes agent-layers stacks, and any agent
reachable over A2A, the same way: its own minimal ports, adapters for the frameworks and standards that already exist,
a config per profile (prototype, pilot, production) and a readiness gate.

Status: design. No code yet.

- **Design:** [docs/design.md](docs/design.md)
- **What exists and what this project adopts:** [docs/research/landscape.md](docs/research/landscape.md)
- **Primitives proposed for agent-layers:** [docs/proposals/agent-layers-delegation-bounds.md](docs/proposals/agent-layers-delegation-bounds.md)
- **Decisions:** [docs/decisions/](docs/decisions/README.md)

## License

MIT. See [LICENSE](LICENSE).
