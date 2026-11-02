import { defineAdapter, inputText, PORT_VERSIONS, type MemberPort } from '@agent-plexus/core';

/** A member that waits for input on its first call and answers with that input once resumed. */
export const adapter = defineAdapter<'MemberPort', Record<string, never>>({
  fills: 'MemberPort',
  name: 'asking-member',
  maps: { technology: 'test fixture' },
  portVersion: PORT_VERSIONS.MemberPort,
  tiers: ['prototype'],
  capabilities: { waits: true, resume: true },
  create: (_options, ctx): MemberPort => ({
    name: ctx.name,
    describe: async () => ({ id: ctx.name, name: ctx.name, description: 'asks for more', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: false } }),
    invoke: async () => ({ status: 'waiting', output: '', reason: { code: 'needs_input', layer: 'member' }, taskRef: 'task-1' }),
    resume: async (taskRef, input) => ({ status: 'completed', output: `${taskRef}: ${input === undefined ? '' : inputText(input)}` }),
  }),
});

export const adapters = [adapter];
