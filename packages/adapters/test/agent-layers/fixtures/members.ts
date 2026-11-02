import type { Caller, Lineage, MemberCallContext, OutboundBounds, RunInput } from '@agent-plexus/core';

/** What the members that record their call saw. */
export const seen: {
  input: RunInput; credential: string | undefined; caller: string | undefined; actors: Caller['actors']; outbound: OutboundBounds; lineage: Lineage | undefined;
}[] = [];

const text = (input: RunInput) => (typeof input === 'string' ? input : input.text);

export const echo = (input: RunInput) => `echo:${text(input)}`;

export const probe = (input: RunInput, ctx: MemberCallContext) => {
  seen.push({ input, credential: ctx.credential, caller: ctx.caller?.id, actors: ctx.caller?.actors, outbound: ctx.outbound, lineage: ctx.lineage });
  return 'probed';
};

export const mail = () => 'write to jane@example.com';

export const leak = () => 'internal NORECEIVE marker';
