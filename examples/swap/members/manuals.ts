import { inputText, type RunInput } from '@agent-plexus/core';

/** Answers product questions from a fixed set of manual entries. */
export function answer(input: RunInput): string {
  const text = inputText(input).toLowerCase();
  if (text.includes('setup')) return 'Manuals: to set up the product, unpack it, connect the power cable and press the start button for 3 seconds.';
  return 'Manuals: the product manual covers setup, daily use and maintenance; ask about any of them.';
}
