# @agent-plexus/core

Ports, host hooks, the memberCall pipeline and system config for [agent-plexus](https://github.com/aantenore/agent-plexus).
Zero runtime dependencies.

The core defines one port per layer between agents: member, registry, routing, topology, execution and attribution.
Adapters map a framework, a protocol or a technology onto a port; a system config (`plexus.json`) picks one adapter
per port, per profile; `assemble` turns the config into a system that runs offline with prototype defaults for the
host hooks.

```bash
npm install @agent-plexus/core @agent-plexus/adapters
```

```ts
import { assemble, loadConfig } from '@agent-plexus/core';

const system = await assemble(await loadConfig('plexus.json', { profile: 'prototype' }));
try {
  const result = await system.run('I need a refund for my last invoice');
  console.log(result.status, result.output);
} finally {
  await system.close();
}
```

Run and check a system from the terminal with [`@agent-plexus/cli`](https://www.npmjs.com/package/@agent-plexus/cli).
Concepts, ports and the adapter catalog are in the
[documentation](https://github.com/aantenore/agent-plexus#readme).

Requires Node >= 22.18. License: MIT.
