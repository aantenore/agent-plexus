import {
  defineAdapter,
  PORT_VERSIONS,
  ATTR,
  type AdapterContext,
  type AgentEntry,
  type Attrs,
  type CandidateFilter,
  type RegistryPort,
  type Skill,
} from '@agent-plexus/core';

export interface SkillOverride {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
}

/** What the config may change on a member's own entry. */
export interface EntryOverride {
  description?: string;
  /** Replaces the member's skills. */
  skills?: SkillOverride[];
  /** Added as one more skill, so tag filters see them. */
  tags?: string[];
  /** Merged over the member's attrs. */
  attrs?: Attrs;
}

/** Which cards the registry hands out. */
export interface TrustPolicy {
  /** Entries must carry a verified card signature (trust.signed). */
  requireSigned?: boolean;
  /** When set, the signature must come from one of these key ids (trust.keyId). Implies requireSigned. */
  keyIds?: string[];
  /** Member ids exempt from the policy (local members that have no card). */
  exempt?: string[];
}

export interface StaticRegistryOptions {
  /** Member id → overrides. Ids that are not configured members are ignored. */
  entries?: Record<string, EntryOverride>;
  /** Entries that fail the policy are neither listed nor returned by `get`. */
  trust?: TrustPolicy;
}

/** Id of the skill that carries the tags given in config. */
export const TAGS_SKILL_ID = 'tags';

/** Event for an entry the trust policy refuses; carries the member id and the reason, never the card. */
export const REFUSED_EVENT = 'plexus.registry.refused';
export const REFUSED_REASON_ATTR = 'plexus.registry.reason';

export type RefusedReason = 'unsigned' | 'key';

function nonEmptyStrings(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v)) throw new TypeError(`static-registry: ${what} must be non-empty strings`);
  return value as string[];
}

function validateTrust(trust: TrustPolicy | undefined): { active: boolean; keyIds?: Set<string>; exempt: Set<string> } {
  if (trust === undefined) return { active: false, exempt: new Set() };
  if (typeof trust !== 'object' || trust === null || Array.isArray(trust)) throw new TypeError('static-registry: trust must be an object');
  if (trust.requireSigned !== undefined && typeof trust.requireSigned !== 'boolean') throw new TypeError('static-registry: trust.requireSigned must be a boolean');
  const keyIds = nonEmptyStrings(trust.keyIds, 'trust.keyIds');
  if (keyIds?.length === 0) throw new TypeError('static-registry: trust.keyIds must not be empty');
  const exempt = nonEmptyStrings(trust.exempt, 'trust.exempt') ?? [];
  return { active: trust.requireSigned === true || keyIds !== undefined, keyIds: keyIds && new Set(keyIds), exempt: new Set(exempt) };
}

function validate(options: StaticRegistryOptions): Record<string, EntryOverride> {
  const entries = options.entries ?? {};
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) throw new TypeError('static-registry: entries must be an object');
  for (const [id, o] of Object.entries(entries)) {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new TypeError(`static-registry: entries.${id} must be an object`);
    if (o.description !== undefined && typeof o.description !== 'string') throw new TypeError(`static-registry: entries.${id}.description must be a string`);
    if (o.tags !== undefined && !(Array.isArray(o.tags) && o.tags.every((t) => typeof t === 'string'))) throw new TypeError(`static-registry: entries.${id}.tags must be strings`);
    if (o.skills !== undefined && !(Array.isArray(o.skills) && o.skills.every((s) => typeof s?.id === 'string' && s.id))) throw new TypeError(`static-registry: entries.${id}.skills need an id`);
    if (o.attrs !== undefined && (typeof o.attrs !== 'object' || o.attrs === null || Array.isArray(o.attrs))) throw new TypeError(`static-registry: entries.${id}.attrs must be an object`);
  }
  return entries;
}

function merge(entry: AgentEntry, override: EntryOverride | undefined): AgentEntry {
  const merged: AgentEntry = { ...entry, skills: entry.skills.map((s) => ({ ...s, tags: [...s.tags] })) };
  if (!override) return merged;
  if (override.description !== undefined) merged.description = override.description;
  if (override.skills) {
    merged.skills = override.skills.map((s): Skill => ({ id: s.id, name: s.name ?? s.id, description: s.description ?? '', tags: [...(s.tags ?? [])] }));
  }
  if (override.tags?.length) {
    merged.skills.push({ id: TAGS_SKILL_ID, name: TAGS_SKILL_ID, description: '', tags: [...override.tags] });
  }
  if (override.attrs) merged.attrs = { ...entry.attrs, ...override.attrs };
  return merged;
}

const asList = (value: Attrs[string]): (string | number | boolean)[] => (Array.isArray(value) ? value : [value]);

/** Equality, where a list on either side means "any of". */
function attrMatches(actual: Attrs[string] | undefined, wanted: Attrs[string]): boolean {
  if (actual === undefined) return false;
  const have = asList(actual);
  return asList(wanted).some((w) => have.includes(w));
}

export function matchesFilter(entry: AgentEntry, filter: CandidateFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.skills?.length && !entry.skills.some((s) => filter.skills?.includes(s.id))) return false;
  if (filter.tags?.length) {
    const present = new Set(entry.skills.flatMap((s) => s.tags));
    if (!filter.tags.every((t) => present.has(t))) return false;
  }
  if (filter.attrs) {
    for (const [key, wanted] of Object.entries(filter.attrs)) {
      const actual = entry.attrs && Object.hasOwn(entry.attrs, key) ? entry.attrs[key] : undefined;
      if (!attrMatches(actual, wanted)) return false;
    }
  }
  return true;
}

/**
 * Registry over the configured members. Their entries come from `ctx.members()` at call time; the config adds
 * descriptions, skills, tags and attrs. Cards are not fetched: `trust` comes from the member that verified its card, and
 * the optional trust policy withholds entries that do not meet it.
 */
export function createStaticRegistry(
  options: StaticRegistryOptions,
  ctx: Pick<AdapterContext, 'name' | 'members'> & Partial<Pick<AdapterContext, 'telemetry'>>,
): RegistryPort {
  const overrides = validate(options);
  const policy = validateTrust(options.trust);
  const members = ctx.members;
  if (typeof members !== 'function') throw new TypeError('static-registry: the context has no members()');
  const refusedAs = new Map<string, string>();
  const refusal = (entry: AgentEntry): RefusedReason | undefined => {
    if (!policy.active || policy.exempt.has(entry.id)) return undefined;
    const trust = entry.trust as AgentEntry['trust'] | undefined;
    if (!trust || trust.signed !== true) return 'unsigned';
    if (policy.keyIds && !(typeof trust.keyId === 'string' && policy.keyIds.has(trust.keyId))) return 'key';
    return undefined;
  };
  // Reported once per entry state: again only after the entry was accepted or its reason or key changed.
  const admit = (entry: AgentEntry): boolean => {
    const reason = refusal(entry);
    if (!reason) {
      refusedAs.delete(entry.id);
      return true;
    }
    const state = `${reason}:${entry.trust?.keyId ?? ''}`;
    if (refusedAs.get(entry.id) !== state) {
      refusedAs.set(entry.id, state);
      ctx.telemetry?.event(REFUSED_EVENT, { [ATTR.layer]: 'registry', [ATTR.member]: entry.id, [REFUSED_REASON_ATTR]: reason });
    }
    return false;
  };
  const all = async (): Promise<AgentEntry[]> =>
    (await members()).filter(admit).map((entry) => merge(entry, Object.hasOwn(overrides, entry.id) ? overrides[entry.id] : undefined));
  return {
    name: ctx.name,
    list: async (filter) => (await all()).filter((entry) => matchesFilter(entry, filter)),
    get: async (id) => (await all()).find((entry) => entry.id === id),
  };
}

export const adapter = defineAdapter<'RegistryPort', StaticRegistryOptions>({
  fills: 'RegistryPort',
  name: 'static-registry',
  maps: { technology: 'static member list' },
  portVersion: PORT_VERSIONS.RegistryPort,
  tiers: ['prototype', 'production'],
  description: 'Lists the configured members, with optional description, skills, tags and attrs set in config, and withholds entries without a verified card signature when asked.',
  optionsSchema: {
    type: 'object',
    properties: {
      entries: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            skills: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', minLength: 1 },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['id'],
                additionalProperties: false,
              },
            },
            tags: { type: 'array', items: { type: 'string' } },
            attrs: { type: 'object' },
          },
          additionalProperties: false,
        },
      },
      trust: {
        type: 'object',
        properties: {
          requireSigned: { type: 'boolean' },
          keyIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          exempt: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createStaticRegistry(options, ctx),
});

export const adapters = [adapter];
