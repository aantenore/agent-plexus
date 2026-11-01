import { defineAdapter, PORT_VERSIONS } from '@agent-layers/core';
import type { GuardCheck } from '@agent-layers/core';

/** Every check the spy guard saw. */
export const checks: GuardCheck[] = [];

export const adapter = defineAdapter({
  layer: 'guardrail',
  port: 'GuardPort',
  name: 'spy-guard',
  direction: 'outbound',
  maps: { technology: 'test spy' },
  portVersion: PORT_VERSIONS.GuardPort,
  tiers: ['prototype'],
  create: (_options, ctx) => ({ name: ctx.name, async check(input) { checks.push(input); return { action: 'allow' }; } }),
});

export const adapters = [adapter];
