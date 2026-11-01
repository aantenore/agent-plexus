/** Adapter descriptors: how a package declares what it fills, for which tiers, with which options and limits. */
import type { Host, TelemetryHook } from './hooks.ts';
import type { Layer } from './layers.ts';
import type { LimitSpec } from './limits.ts';
import type { AgentRouterPort, AttributionPort, ExecutionPort, MemberPort, PortName, RegistryPort, TopologyPort } from './ports.ts';
import type { AgentEntry } from './shapes.ts';

export type Tier = 'prototype' | 'production';
export const TIERS: readonly Tier[] = ['prototype', 'production'];

/** What an adapter fills: one of the six ports, or the host hooks. */
export interface FillTypes {
  MemberPort: MemberPort;
  RegistryPort: RegistryPort;
  AgentRouterPort: AgentRouterPort;
  TopologyPort: TopologyPort;
  ExecutionPort: ExecutionPort;
  AttributionPort: AttributionPort;
  Host: Host;
}
export type Fills = keyof FillTypes;

export const LAYER_OF: Readonly<Record<PortName, Layer>> = {
  MemberPort: 'member',
  RegistryPort: 'registry',
  AgentRouterPort: 'routing',
  TopologyPort: 'topology',
  ExecutionPort: 'execution',
  AttributionPort: 'attribution',
};

/** A small JSON Schema subset, enough to validate adapter options without a dependency. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
  oneOf?: JsonSchema[];
}

export interface AdapterContext {
  /** Name of the system being assembled. */
  system: string;
  /** Instance name: the member id for members, the port key otherwise. */
  name: string;
  /** Directory of the system config; relative paths in options resolve against it. */
  cwd: string;
  env: Record<string, string | undefined>;
  telemetry: TelemetryHook;
  /** Entries of the configured members, for registries. Call it when used, not inside `create`. */
  members?: () => Promise<AgentEntry[]>;
}

export interface AdapterDescriptor<F extends Fills = Fills, O = Record<string, unknown>> {
  fills: F;
  name: string;
  /** What the adapter maps: an open standard, or a technology's native API. */
  maps: { standard?: string; technology?: string };
  /** Port version implemented (absent for hosts). */
  portVersion?: string;
  tiers: readonly Tier[];
  description?: string;
  optionsSchema?: JsonSchema;
  limits?: Readonly<Record<string, LimitSpec>>;
  create(options: O, ctx: AdapterContext): FillTypes[F] | Promise<FillTypes[F]>;
}

export function defineAdapter<F extends Fills, O = Record<string, unknown>>(d: AdapterDescriptor<F, O>): AdapterDescriptor<F, O> {
  if (!d?.name || !/^[a-z0-9][a-z0-9-]*$/.test(d.name)) throw new TypeError(`adapter "${String(d?.name)}": name must be lowercase kebab-case`);
  if (!d.tiers?.length) throw new TypeError(`adapter "${d.name}": tiers must not be empty`);
  if (typeof d.create !== 'function') throw new TypeError(`adapter "${d.name}": create must be a function`);
  return d;
}
