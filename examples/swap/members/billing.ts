import { inputText, type MemberResult, type RunInput } from '@agent-plexus/core';

/** Answers invoice and refund questions. An input containing "crash" makes it stop with an error, to demonstrate attribution. */
export function answer(input: RunInput): string | MemberResult {
  const text = inputText(input).toLowerCase();
  if (text.includes('crash')) return { status: 'stopped', output: '', reason: { code: 'error' } };
  if (text.includes('refund')) return 'Billing: refunds are issued to the original payment method within 5 business days.';
  if (text.includes('charge')) return 'Billing: a charge appears on your statement within 2 business days; disputes are open for 60 days.';
  return 'Billing: invoices are issued on the first day of the month and can be downloaded from the billing page.';
}
