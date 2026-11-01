import {
  defineAdapter, inputText, PORT_VERSIONS,
  type AdapterContext, type AgentEntry, type AgentRouterPort, type RouteDecision,
} from '@agent-plexus/core';

export interface KeywordRouterOptions {
  /** Distinct shared words a candidate needs to be chosen (default 1). */
  threshold?: number;
}

export const DEFAULT_THRESHOLD = 1;

const NAME = 'keyword-router';

/** Words too common to tell two agents apart. */
const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'have', 'has', 'how', 'what', 'when', 'will', 'can', 'you', 'your', 'about', 'any', 'all']);

/** Lowercase words of three letters or more, without the common ones. */
export function keywords(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return new Set(words);
}

/** The words an entry is known by: its description and the name, description and tags of each skill. */
function profile(entry: AgentEntry): Set<string> {
  const text = [entry.description, ...entry.skills.flatMap((s) => [s.name, s.description, ...s.tags])].join(' ');
  return keywords(text);
}

/** Router that scores each candidate by the words its profile shares with the input and picks the best above a threshold. */
export function createKeywordRouter(options: KeywordRouterOptions, ctx: Pick<AdapterContext, 'name'>): AgentRouterPort {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 1) throw new TypeError(`${NAME}: threshold must be an integer of at least 1`);
  return {
    name: ctx.name,
    async route(question): Promise<RouteDecision> {
      const wanted = keywords(inputText(question.input));
      const ranked = question.candidates
        .map((c) => ({ member: c.id, score: [...profile(c)].filter((w) => wanted.has(w)).length }))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (!best || best.score < threshold) return { ranked, reason: `no candidate shares ${threshold} word(s) with the input` };
      return { member: best.member, ranked, reason: `${best.score} shared word(s)` };
    },
  };
}

export const adapter = defineAdapter<'AgentRouterPort', KeywordRouterOptions>({
  fills: 'AgentRouterPort',
  name: NAME,
  maps: { technology: 'keyword overlap between the input and the agent entry' },
  portVersion: PORT_VERSIONS.AgentRouterPort,
  tiers: ['prototype', 'production'],
  description: 'Chooses the candidate whose description and skill tags share the most words with the input.',
  optionsSchema: {
    type: 'object',
    properties: { threshold: { type: 'integer', minimum: 1 } },
    additionalProperties: false,
  },
  create: (options, ctx) => createKeywordRouter(options, ctx),
});

export const adapters = [adapter];
