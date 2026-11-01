import type { RunInput } from '@agent-plexus/core';

const text = (input: RunInput) => (typeof input === 'string' ? input : input.text);

/** First line of support: turns any question into the one the billing agent answers. */
export const triage = (input: RunInput) => (text(input).includes('invoice') ? 'ping' : 'nothing to do');
