import { writeFileSync } from 'node:fs';
import { defineAdapter, PORT_VERSIONS, type MemberPort } from '@agent-plexus/core';

/** A member that never answers: it writes the marker file when called, so a test knows the call is in flight. */
export const adapter = defineAdapter<'MemberPort', { marker: string }>({
  fills: 'MemberPort',
  name: 'slow-member',
  maps: { technology: 'test fixture' },
  portVersion: PORT_VERSIONS.MemberPort,
  tiers: ['prototype'],
  optionsSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false },
  create: (options, ctx): MemberPort => ({
    name: ctx.name,
    describe: async () => ({ id: ctx.name, name: ctx.name, description: 'never answers', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: false } }),
    invoke: () => {
      writeFileSync(options.marker, '');
      return new Promise(() => {});
    },
  }),
});

export const adapters = [adapter];
