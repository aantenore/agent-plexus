import type { OutboundBounds } from '@agent-plexus/core';

/**
 * URI of the A2A extension that carries a run's bounds to the next agent and its report back: the canonical one,
 * published with agent-layers (see spec/extensions/bounds-v1.md).
 */
export const BOUNDS_URI = 'https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md';
/** The same extension under the URI agent-plexus published first: an alias, same data, for peers that know only it. */
export const BOUNDS_ALIAS_URI = 'https://github.com/aantenore/agent-plexus/blob/main/spec/extensions/bounds-v1.md';

/** Which URI the member sends: `canonical` (default) or `plexus`, the alias, for older peers. */
export type BoundsUriOption = 'canonical' | 'plexus';
export const BOUNDS_URI_OPTIONS: readonly BoundsUriOption[] = ['canonical', 'plexus'];

export const boundsUriOf = (option: BoundsUriOption = 'canonical'): string => (option === 'plexus' ? BOUNDS_ALIAS_URI : BOUNDS_URI);

/** The extension data for one message: the outbound bounds with the time left already tightened to `remainingMs`. */
export function boundsData(outbound: OutboundBounds, remainingMs: number): Record<string, unknown> {
  const data: Record<string, unknown> = {
    remainingMs: Math.max(0, Math.floor(remainingMs)),
    hops: outbound.hops,
    maxHops: outbound.maxHops,
  };
  if (outbound.tokens !== undefined) data.tokens = outbound.tokens;
  if (outbound.costUsd !== undefined) data.costUsd = outbound.costUsd;
  data.rootRunId = outbound.rootRunId;
  data.parentRunId = outbound.parentRunId;
  return data;
}
