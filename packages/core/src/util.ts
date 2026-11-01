import type { Caller } from './shapes.ts';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The caller without its credential, for everything that is not a token request. */
export function withoutCredential(caller: Caller): Caller {
  const { credential: _credential, ...rest } = caller;
  return rest;
}
