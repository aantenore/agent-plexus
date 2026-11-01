import { inputText, type MemberResult, type RunInput } from '@agent-plexus/core';

interface Rule {
  /** The rule applies when the request contains any of these words. */
  words: string[];
  /** The member result for the request. */
  result: MemberResult;
}

const completed = (output: string): MemberResult => ({ status: 'completed', output });

/** Rules in priority order; the first that applies answers. */
const RULES: readonly Rule[] = [
  { words: ['crash'], result: { status: 'stopped', output: '', reason: { code: 'error' } } },
  { words: ['refund'], result: completed('Billing: refunds are issued to the original payment method within 5 business days.') },
  { words: ['charge'], result: completed('Billing: a charge appears on your statement within 2 business days; disputes are open for 60 days.') },
];

const DEFAULT = completed('Billing: invoices are issued on the first day of the month and can be downloaded from the billing page.');

/** The same answers as `billing.ts`, driven by a table instead of a chain of conditions. */
export function answer(input: RunInput): MemberResult {
  const text = inputText(input).toLowerCase();
  return structuredClone(RULES.find((rule) => rule.words.some((word) => text.includes(word)))?.result ?? DEFAULT);
}
