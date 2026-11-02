import {
  defineAdapter,
  defineLimits,
  inputText,
  PORT_VERSIONS,
  type AdapterContext,
  type AgentEntry,
  type AgentRouterPort,
  type RouteDecision,
} from '@agent-plexus/core';

export interface RouterRule {
  /** Member id the rule picks. */
  member: string;
  /** Regular expression on the input text; a leading `(?i)` (also `m`, `s`) sets flags. */
  matches?: string;
  /** Tags the candidate must carry, across its skills. */
  tags?: string[];
  /** Skill ids the candidate must have. */
  skills?: string[];
  /** Higher wins; default 1. Rule order breaks ties. */
  weight?: number;
}

export interface SkillRouterOptions {
  rules: RouterRule[];
  /** When no rule applies, still return every candidate in `ranked` (score 0), without choosing a member. */
  fallbackRanking?: boolean;
  /** Input characters given to a regular expression; the rest is ignored. */
  maxInputChars?: number;
}

export const limits = defineLimits({
  maxInputChars: {
    path: 'options.maxInputChars',
    default: 10_000,
    unit: 'count',
    min: 1,
    integer: true,
    why: 'Input characters a rule regular expression reads; bounds the cost of a slow expression on a huge input.',
  },
});

const DEFAULT_WEIGHT = 1;
const INLINE_FLAGS = /^\(\?([ims]+)\)/;

/** Compiles a pattern, translating a leading `(?i)` style prefix to flags. Throws on an invalid pattern. */
export function compilePattern(pattern: string): RegExp {
  const prefix = INLINE_FLAGS.exec(pattern);
  const flags = prefix ? [...new Set(prefix[1])].join('') : '';
  return new RegExp(prefix ? pattern.slice(prefix[0].length) : pattern, flags);
}

interface CompiledRule {
  member: string;
  regex?: RegExp;
  tags: string[];
  skills: string[];
  weight: number;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function compileRules(rules: unknown): CompiledRule[] {
  if (!Array.isArray(rules)) throw new TypeError('skill-router: rules must be an array');
  return rules.map((r: RouterRule, i) => {
    const where = `skill-router: rules[${i}]`;
    if (typeof r !== 'object' || r === null) throw new TypeError(`${where} must be an object`);
    if (typeof r.member !== 'string' || !r.member) throw new TypeError(`${where}.member must be a non-empty string`);
    if (r.tags !== undefined && !isStrings(r.tags)) throw new TypeError(`${where}.tags must be strings`);
    if (r.skills !== undefined && !isStrings(r.skills)) throw new TypeError(`${where}.skills must be strings`);
    if (r.weight !== undefined && (typeof r.weight !== 'number' || !Number.isFinite(r.weight))) throw new TypeError(`${where}.weight must be a finite number`);
    let regex: RegExp | undefined;
    if (r.matches !== undefined) {
      if (typeof r.matches !== 'string') throw new TypeError(`${where}.matches must be a string`);
      try {
        regex = compilePattern(r.matches);
      } catch (error) {
        throw new TypeError(`${where}.matches is not a valid regular expression: ${(error as Error).message}`);
      }
    }
    return { member: r.member, ...(regex ? { regex } : {}), tags: r.tags ?? [], skills: r.skills ?? [], weight: r.weight ?? DEFAULT_WEIGHT };
  });
}

function entryHolds(rule: CompiledRule, entry: AgentEntry): boolean {
  if (rule.skills.length) {
    const ids = new Set(entry.skills.map((s) => s.id));
    if (!rule.skills.every((s) => ids.has(s))) return false;
  }
  if (rule.tags.length) {
    const present = new Set(entry.skills.flatMap((s) => s.tags));
    if (!rule.tags.every((t) => present.has(t))) return false;
  }
  return true;
}

/** Router that picks the best-weighted rule that applies to a candidate. */
export function createSkillRouter(options: SkillRouterOptions, ctx: Pick<AdapterContext, 'name'>): AgentRouterPort {
  const rules = compileRules(options?.rules);
  const maxInputChars = options.maxInputChars ?? limits.maxInputChars.default;
  if (typeof maxInputChars !== 'number' || !Number.isInteger(maxInputChars) || maxInputChars < limits.maxInputChars.min) {
    throw new TypeError('skill-router: maxInputChars must be an integer of at least 1');
  }
  const fallbackRanking = options.fallbackRanking === true;

  return {
    name: ctx.name,
    async route(question): Promise<RouteDecision> {
      const candidates = new Map(question.candidates.map((c) => [c.id, c]));
      const text = inputText(question.input).slice(0, maxInputChars);
      const best = new Map<string, number>();
      for (const rule of rules) {
        const entry = candidates.get(rule.member);
        if (!entry || !entryHolds(rule, entry)) continue;
        if (rule.regex && !rule.regex.test(text)) continue;
        const seen = best.get(rule.member);
        if (seen === undefined || rule.weight > seen) best.set(rule.member, rule.weight);
      }
      // Map keeps first-applicable order, and sort is stable, so rule order breaks ties.
      const ranked = [...best].map(([member, score]) => ({ member, score })).sort((a, b) => b.score - a.score);
      const top = ranked[0];
      if (top) return { member: top.member, ranked, reason: `rule weight ${top.score}` };
      if (fallbackRanking) return { ranked: question.candidates.map((c) => ({ member: c.id, score: 0 })), reason: 'no rule applies' };
      return {};
    },
  };
}

export const adapter = defineAdapter<'AgentRouterPort', SkillRouterOptions>({
  fills: 'AgentRouterPort',
  name: 'skill-router',
  maps: { technology: 'rules on regular expressions, tags and skills' },
  portVersion: PORT_VERSIONS.AgentRouterPort,
  tiers: ['prototype', 'production'],
  description: 'Chooses a member among the candidates by weighted rules on the input text and on skills and tags.',
  optionsSchema: {
    type: 'object',
    properties: {
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            member: { type: 'string', minLength: 1 },
            matches: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            skills: { type: 'array', items: { type: 'string' } },
            weight: { type: 'number' },
          },
          required: ['member'],
          additionalProperties: false,
        },
      },
      fallbackRanking: { type: 'boolean' },
      maxInputChars: { type: 'integer', minimum: limits.maxInputChars.min },
    },
    required: ['rules'],
    additionalProperties: false,
  },
  limits,
  create: (options, ctx) => createSkillRouter(options, ctx),
});

export const adapters = [adapter];
