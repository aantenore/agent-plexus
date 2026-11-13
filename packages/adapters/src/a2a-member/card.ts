import { DefaultAgentCardResolver, JsonRpcTransportFactory, Client } from '@a2a-js/sdk/client';
import { verifyAgentCardSignature, type AgentCard } from '@a2a-js/sdk';
import type { AgentEntry, Skill } from '@agent-plexus/core';
import { checkTarget, createGuardedFetch, endpointAllowed, fetchDocument, Refused, createTransportFetch, type TargetRules } from './guard.ts';

/** A public key the operator configured, as a JWK. */
export type PublicJwk = Record<string, unknown> & { kty: string; kid?: string };

export interface CardOptions {
  url: string;
  endpoint?: string;
  allowedEndpoints: string[];
  /** JWKs, or the URL of a JWKS document, for card signatures. */
  keys?: PublicJwk[] | string;
  requireSigned: boolean;
  maxCardBytes: number;
  /** Largest JSON-RPC answer read. */
  maxResponseBytes: number;
  cardTtlMs: number;
  /** Time limit of fetching the card and the key set; `Infinity` for none. */
  fetchTimeoutMs: number;
}

/** What a resolved target gives the calls: a client bound to the endpoint, and the entry fields from the card. */
export interface Target {
  client: Client;
  endpoint: string;
  card?: AgentCard;
  signed: boolean;
  keyId?: string;
}

const CARD_PATH = /agent-card\.json$|agent\.json$/;

type KeyLookup = Parameters<typeof verifyAgentCardSignature>[0];
type Key = Awaited<ReturnType<KeyLookup>>;

const resolver = new DefaultAgentCardResolver({ legacyCompat: { enabled: true } });

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates configured keys: public asymmetric JWKs only. */
export function checkKeys(keys: unknown): PublicJwk[] {
  if (!Array.isArray(keys)) throw new TypeError('a2a-member: keys must be an array of JWKs or a JWKS URL');
  return keys.map((k, i) => {
    if (!isPlain(k) || typeof k.kty !== 'string') throw new TypeError(`a2a-member: keys[${i}] must be a JWK`);
    if (!['EC', 'RSA', 'OKP'].includes(k.kty)) throw new TypeError(`a2a-member: keys[${i}] must be an asymmetric public key`);
    if ('d' in k || 'k' in k || 'p' in k || 'q' in k) throw new TypeError(`a2a-member: keys[${i}] must be a public key, without private parts`);
    return k as PublicJwk;
  });
}

function memo<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let slot: { at: number; value: Promise<T> } | undefined;
  return () => {
    if (slot && performance.now() - slot.at < ttlMs) return slot.value;
    const value = load();
    const mine = { at: performance.now(), value };
    slot = mine;
    value.catch(() => {
      if (slot === mine) slot = undefined;
    });
    return value;
  };
}

/** Resolves the card and the endpoint under the target rules; the result is cached for `cardTtlMs`. */
export function createTargetSource(options: CardOptions, rules: TargetRules): () => Promise<Target> {
  const timeout = (): AbortSignal | undefined => (Number.isFinite(options.fetchTimeoutMs) ? AbortSignal.timeout(options.fetchTimeoutMs) : undefined);
  const hasCard = CARD_PATH.test(new URL(options.url).pathname);
  // Every request of this member, so a host name is checked again as resolved, on the connection that uses it.
  const send = createGuardedFetch(rules);

  const keySet = typeof options.keys === 'string'
    ? memo(options.cardTtlMs, async () => {
        const doc = await fetchDocument(checkTarget(options.keys as string, 'keys URL', rules), options.maxCardBytes, timeout(), send);
        return checkKeys(isPlain(doc) ? doc.keys : undefined);
      })
    : async (): Promise<PublicJwk[]> => (options.keys as PublicJwk[] | undefined) ?? [];

  /** Verifies the card's signatures against the configured keys; the key id of the one that verified. */
  async function verify(card: AgentCard): Promise<{ signed: boolean; keyId?: string }> {
    const signatures = Array.isArray(card.signatures) ? card.signatures : [];
    if (signatures.length === 0) return { signed: false };
    if (options.keys === undefined) return { signed: false };
    let keys: PublicJwk[];
    try {
      keys = await keySet();
    } catch {
      return { signed: false };
    }
    let last: string | undefined;
    // The card's own `jku` is never fetched: keys come from the operator only.
    const lookup: KeyLookup = async (kid) => {
      const key = keys.find((k) => k.kid === kid);
      if (!key) throw new Refused('no configured key for the card signature');
      last = kid;
      return key as unknown as Key;
    };
    try {
      await verifyAgentCardSignature(lookup)(card);
    } catch {
      return { signed: false };
    }
    return last === undefined ? { signed: true } : { signed: true, keyId: last };
  }

  async function open(): Promise<Target> {
    const configuredEndpoint = options.endpoint ? checkTarget(options.endpoint, 'endpoint', rules) : undefined;
    let card: AgentCard | undefined;
    let signed = false;
    let keyId: string | undefined;
    let url: URL;
    if (hasCard) {
      const cardUrl = checkTarget(options.url, 'url', rules);
      const raw = await fetchDocument(cardUrl, options.maxCardBytes, timeout(), send);
      if (!isPlain(raw)) throw new Refused('the agent card is not an object');
      card = resolver.normalizeAgentCard(raw);
      const proof = await verify(card);
      signed = proof.signed;
      if (proof.keyId !== undefined) keyId = proof.keyId;
      if (options.requireSigned && !signed) throw new Refused('the agent card is not signed by a configured key');
      if (configuredEndpoint) {
        url = configuredEndpoint;
      } else {
        const iface = (card.supportedInterfaces ?? []).filter((i) => i.protocolBinding?.toUpperCase() === 'JSONRPC');
        const chosen = iface.find((i) => i.protocolVersion === '1.0') ?? iface[0];
        if (!chosen || typeof chosen.url !== 'string') throw new Refused('the agent card offers no JSON-RPC interface');
        const target = checkTarget(chosen.url, 'the endpoint of the agent card', rules);
        if (!endpointAllowed(target, cardUrl, options.allowedEndpoints)) throw new Refused('the agent card points to an endpoint outside its origin and allowedEndpoints');
        url = target;
      }
    } else {
      if (options.requireSigned) throw new Refused('a signed card is required but url is not an agent card');
      url = configuredEndpoint ?? checkTarget(options.url, 'url', rules);
    }
    // Without a card the endpoint speaks A2A 1.0.
    const boundCard = card ?? ({
      name: '', description: '', version: '', skills: [], signatures: [], securitySchemes: {}, securityRequirements: [],
      defaultInputModes: [], defaultOutputModes: [], provider: undefined,
      capabilities: { extensions: [] },
      supportedInterfaces: [{ url: url.href, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    } satisfies AgentCard);
    const transport = await new JsonRpcTransportFactory({ fetchImpl: createTransportFetch(options.maxResponseBytes, send), legacyCompat: { enabled: true } }).create(url.href, boundCard);
    const client = new Client(transport, boundCard, { polling: true });
    const target: Target = { client, endpoint: url.href, signed };
    if (card) target.card = card;
    if (keyId !== undefined) target.keyId = keyId;
    return target;
  }

  return memo(options.cardTtlMs, open);
}

/** Skills of a card as plexus skills; fields of the wrong type are left out. */
export function skillsOf(card: AgentCard | undefined): Skill[] {
  const list: unknown = card?.skills;
  if (!Array.isArray(list)) return [];
  return list.flatMap((s: unknown) => {
    if (!isPlain(s) || typeof s.id !== 'string' || !s.id) return [];
    const tags = Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [];
    return [{ id: s.id, name: typeof s.name === 'string' ? s.name : s.id, description: typeof s.description === 'string' ? s.description : '', tags }];
  });
}

/** The registry entry of a resolved target. `audience` comes from the options, never from the card. */
export function entryOf(id: string, target: Target, audience: string | undefined): AgentEntry {
  const card = target.card;
  const entry: AgentEntry = {
    id,
    name: card && typeof card.name === 'string' && card.name ? card.name : id,
    description: card && typeof card.description === 'string' ? card.description : '',
    skills: skillsOf(card),
    endpoint: { protocol: 'a2a', url: target.endpoint },
    // The endpoint is always one the operator configured or the card's own configured origin: pinned.
    trust: target.keyId !== undefined ? { signed: target.signed, keyId: target.keyId, pinned: true } : { signed: target.signed, pinned: true },
  };
  if (audience !== undefined) entry.audience = audience;
  if (card && typeof card.version === 'string' && card.version) entry.version = card.version;
  return entry;
}
