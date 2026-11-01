import type { MemberCallContext, RunInput } from '@agent-plexus/core';

/** What the members that record their call saw. */
export const seen: { input: RunInput; credential: string | undefined; caller: string | undefined }[] = [];

const text = (input: RunInput) => (typeof input === 'string' ? input : input.text);

export const echo = (input: RunInput) => `echo:${text(input)}`;

export const probe = (input: RunInput, ctx: MemberCallContext) => {
  seen.push({ input, credential: ctx.credential, caller: ctx.caller?.id });
  return 'probed';
};

export const mail = () => 'write to jane@example.com';

export const leak = () => 'internal NORECEIVE marker';
