import { inputText, type RunInput } from '@agent-plexus/core';

/** Restates the request so the next member works from a clean statement of it. */
export function answer(input: RunInput): string {
  return `Request received: ${inputText(input).trim()}`;
}
