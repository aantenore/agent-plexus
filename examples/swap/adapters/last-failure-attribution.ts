import {
  defineAdapter, PORT_VERSIONS,
  type Attribution, type AttributionInput, type AttributionPort, type AdapterContext,
} from '@agent-plexus/core';

const NAME = 'last-failure-attribution';

/** Fixed: this adapter does not weigh evidence, it points at the last failure. */
const CONFIDENCE = 0.5;

/**
 * Attribution by one rule: the last hop that did not complete is to blame. A hop with a member blames that member on
 * layer `member`; a hop with no member is a route that chose nobody and blames layer `routing`. Abandoned hops are
 * skipped, and so are waiting hops (`needs_input`, `needs_auth`) and `aborted` stops, which are not failures: a run
 * with no such hop has nothing to attribute.
 */
export function createLastFailureAttribution(_options: Record<string, never>, ctx: Pick<AdapterContext, 'name'>): AttributionPort {
  return {
    name: ctx.name,
    async attribute({ record }: AttributionInput): Promise<Attribution[]> {
      const failed = record.filter((h) => !h.abandoned && h.status !== 'completed' && h.status !== 'waiting' && h.reason?.code !== 'aborted').at(-1);
      if (!failed) return [];
      const code = failed.reason?.code;
      return [{
        layer: failed.member ? 'member' : 'routing',
        ...(failed.member ? { member: failed.member } : {}),
        hopId: failed.hopId,
        confidence: CONFIDENCE,
        evidence: [`hop:${failed.hopId}`, `status:${failed.status}`, ...(code ? [`code:${code}`] : [])],
        by: NAME,
      }];
    },
  };
}

export const adapter = defineAdapter<'AttributionPort', Record<string, never>>({
  fills: 'AttributionPort',
  name: NAME,
  maps: { technology: 'last failed hop of the record' },
  portVersion: PORT_VERSIONS.AttributionPort,
  tiers: ['prototype', 'production'],
  description: 'Blames the member of the last hop that did not complete, on layer member.',
  optionsSchema: { type: 'object', properties: {}, additionalProperties: false },
  create: (options, ctx) => createLastFailureAttribution(options, ctx),
});

export const adapters = [adapter];
