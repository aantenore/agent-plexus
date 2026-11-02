# @agent-plexus/adapters

The reference adapters of [agent-plexus](https://github.com/aantenore/agent-plexus), one subpath export each. A system
config names an adapter by its subpath (`"adapter": "skill-router"` loads `@agent-plexus/adapters/skill-router`).

```bash
npm install @agent-plexus/core @agent-plexus/adapters
```

| Subpath | Fills | Maps | Needs |
|---|---|---|---|
| [`a2a-member`](src/a2a-member/README.md) | MemberPort | A remote agent over the Agent2Agent (A2A) protocol | `@a2a-js/sdk` |
| [`agent-layers`](src/agent-layers/README.md) | Host, MemberPort | An agent-layers stack as host or member | `@agent-layers/core` |
| [`agent-layers/runtime`](src/agent-layers/README.md#runtime) | agent-layers RuntimePort | A system as the runtime of an agent-layers stack (plugin of an agent-layers config) | `@agent-layers/core` |
| [`basic-topology`](src/basic-topology/README.md) | TopologyPort | In-process topology executor | |
| [`function-member`](src/function-member/README.md) | MemberPort | An in-process function | |
| [`memory-execution`](src/memory-execution/README.md) | ExecutionPort | In-memory execution journal (prototype) | |
| [`rule-attribution`](src/rule-attribution/README.md) | AttributionPort | Deterministic failure attribution across hops | |
| [`skill-router`](src/skill-router/README.md) | AgentRouterPort | Rules on regular expressions, tags and skills | |
| [`sqlite-execution`](src/sqlite-execution/README.md) | ExecutionPort | Durable execution journal on SQLite (`node:sqlite`) | |
| [`static-registry`](src/static-registry/README.md) | RegistryPort | The configured members, with optional overrides | |

`@agent-plexus/core` is a peer dependency. The libraries in **Needs** are optional peer dependencies: installing this
package pulls in none of them; install the one an adapter needs next to it (`npm install @a2a-js/sdk`). An adapter
whose library is missing fails to load with a message that names it.

The adapter READMEs are in the
[repository](https://github.com/aantenore/agent-plexus/tree/main/packages/adapters/src). Catalog and maturity:
[docs/adapters.md](https://github.com/aantenore/agent-plexus/blob/main/docs/adapters.md).

Requires Node >= 22.18. License: MIT.
