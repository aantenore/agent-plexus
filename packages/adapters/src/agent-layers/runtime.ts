import { defineAdapter, PORT_VERSIONS } from '@agent-layers/core';
import type { RuntimePort } from '@agent-layers/core';
import { createRuntime, type RuntimeOptions } from './runtime-port.ts';

export { createRuntime, type RuntimeOptions } from './runtime-port.ts';

/** Loaded by an agent-layers config through `"plugins": ["@agent-plexus/adapters/agent-layers/runtime"]`. */
export const runtimeAdapter = defineAdapter<'RuntimePort', RuntimeOptions>({
  layer: 'harness',
  port: 'RuntimePort',
  name: 'agent-plexus',
  direction: 'outbound',
  maps: { technology: 'agent-plexus system' },
  portVersion: PORT_VERSIONS.RuntimePort,
  tiers: ['prototype', 'production'],
  description: 'Runs an agent-plexus system as the runtime of an agent: the stack governs the system, the system composes the members.',
  optionsSchema: {
    type: 'object',
    properties: {
      system: { type: 'string', minLength: 1 },
      profile: { type: 'string', minLength: 1 },
      risk: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
      approve: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
    required: ['system'],
    additionalProperties: false,
  },
  ext: { produces: ['agent-plexus.hops'] },
  create: (options, ctx): RuntimePort => createRuntime(options, ctx.cwd, ctx.name),
});

export const adapters = [runtimeAdapter];
