/** The six layers of agent-plexus. Ids are stable; the numbers are for reading only. */
export const LAYERS = ['member', 'registry', 'routing', 'topology', 'execution', 'attribution'] as const;
export type Layer = (typeof LAYERS)[number];

/** Where an attribution can point: a layer, or the host when its gate refused a call. */
export type AttributionLayer = Layer | 'host';

export const isLayer = (value: unknown): value is Layer => typeof value === 'string' && (LAYERS as readonly string[]).includes(value);
