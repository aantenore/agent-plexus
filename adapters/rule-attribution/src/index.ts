import {
  defineAdapter,
  isLayer,
  PORT_VERSIONS,
  type AdapterContext,
  type Attribution,
  type AttributionInput,
  type AttributionLayer,
  type AttributionPort,
  type HopRecord,
  type RecordSource,
  type StopReason,
} from '@agent-plexus/core';

export type { Attribution };

/** Confidence of each grade, in [0, 1]. */
export const CONFIDENCE = { high: 0.9, medium: 0.6, low: 0.3 } as const;

export const ADAPTER_NAME = 'rule-attribution';

/** Smallest share of a member's output that its input must be for the member to count as having only repeated its input. */
export const DEFAULT_ECHO_SHARE = 0.5;

export interface RuleAttributionOptions {
  /** In (0, 1]; defaults to `DEFAULT_ECHO_SHARE`. */
  echoShare?: number;
}

const ERROR_REASON: StopReason = { code: 'error' };

interface Finding {
  layer: AttributionLayer;
  hopId?: string;
  member?: string;
  confidence: number;
  evidence: string[];
  /** Hop whose spans, and reason, tell the member's own layer. */
  layerFrom?: HopRecord;
  reason?: StopReason;
  /** High when the member reported its own layer, medium when not. */
  graded?: boolean;
}

/** Hops that count: the topology did not abandon them. */
const live = (record: HopRecord[]) => record.filter((h) => !h.abandoned);

/** A hop of a route node whose router chose no member. */
const routeChoseNothing = (hop: HopRecord) => hop.route !== undefined && !hop.route.member;

const hopEvidence = (hop: HopRecord) => [`hop:${hop.hopId}`, `node:${hop.node}`];

/** Names the hop; a route node has no member, so none is named. */
const at = (hop: HopRecord): Pick<Finding, 'hopId' | 'member'> => ({ hopId: hop.hopId, ...(hop.member ? { member: hop.member } : {}) });

/** The member hop before `index` in record order that completed: the one whose output fed this hop. */
const previousCompleted = (hops: HopRecord[], index: number) => hops.slice(0, index).reverse().find((h) => h.status === 'completed' && h.member !== '');

/** A stored text of the journal; undefined when the key, the reader or the text is missing, or the read fails. */
async function readText(source: RecordSource | undefined, key: string | undefined): Promise<string | undefined> {
  if (!key || !source?.text) return undefined;
  try {
    return await source.text(key);
  } catch {
    return undefined;
  }
}

/** The member only repeated what it received: its output holds its input, and the input is at least `share` of the output. */
async function echoed(hop: HopRecord, source: RecordSource | undefined, share: number): Promise<boolean> {
  const [input, output] = await Promise.all([readText(source, hop.inputRef), readText(source, hop.outputRef)]);
  const sent = input?.trim();
  return Boolean(sent && output !== undefined && output.includes(sent) && sent.length >= share * output.length);
}

/** Where a blocked content came from: the first upstream member that added text, or the caller's input when every one only repeated it. */
interface Origin {
  blamed?: HopRecord;
  echoes: string[];
}

/** Walks upstream from the hop at `index` through the members that only repeated their input. Undefined: no upstream member. */
async function traceOrigin(hops: HopRecord[], index: number, source: RecordSource | undefined, share: number): Promise<Origin | undefined> {
  let current = previousCompleted(hops, index);
  if (!current) return undefined;
  const echoes: string[] = [];
  while (await echoed(current, source, share)) {
    echoes.push(`echo:${current.hopId}`);
    const prev = previousCompleted(hops, hops.indexOf(current));
    if (!prev) return { echoes };
    const [given, received] = await Promise.all([readText(source, prev.outputRef), readText(source, current.inputRef)]);
    if (given === undefined || received === undefined || given !== received) return { echoes };
    current = prev;
  }
  return { blamed: current, echoes };
}

/** The member hop with the largest value of `measure`; the earliest wins a tie. Hops where it is undefined are not counted. */
function largest(hops: HopRecord[], measure: (hop: HopRecord) => number | undefined): HopRecord | undefined {
  let best: HopRecord | undefined;
  let bestValue = -Infinity;
  for (const hop of hops) {
    const value = hop.member ? measure(hop) : undefined;
    if (value !== undefined && value > bestValue) [best, bestValue] = [hop, value];
  }
  return best;
}

/** Spend of this invocation only: a replayed hop's usage and cost were spent by an earlier one. */
const tokens = (hop: HopRecord) => (hop.usage && !hop.replayed ? hop.usage.inputTokens + hop.usage.outputTokens : undefined);
const cost = (hop: HopRecord) => (hop.replayed ? undefined : hop.costUsd);

/**
 * The member that spent the most in this invocation: for `limit` the most tokens, else the highest cost, else the most
 * time; for `timeout` the most time. Replayed hops spent nothing here.
 */
function biggestSpender(hops: HopRecord[], code: string): HopRecord | undefined {
  if (code === 'limit') {
    const measure = hops.some((h) => h.member && tokens(h) !== undefined) ? tokens : hops.some((h) => h.member && cost(h) !== undefined) ? cost : undefined;
    if (measure) return largest(hops, measure);
  }
  return largest(hops, (h) => h.durationMs);
}

function findCandidate(hops: HopRecord[], scores: AttributionInput['scores']): HopRecord | undefined {
  const failing = new Set(scores.filter((s) => s.member !== undefined && s.value < 1).map((s) => s.member));
  return hops.find((h) => h.status !== 'completed' || (h.member !== '' && failing.has(h.member)));
}

/** Rule 3: the stop code of the candidate decides layer, member and confidence. Undefined: not a failure. */
async function byStopCode(candidate: HopRecord, index: number, hops: HopRecord[], source: RecordSource | undefined, share: number): Promise<Finding | undefined> {
  const reason = candidate.reason ?? (candidate.status === 'waiting' ? undefined : ERROR_REASON);
  if (!reason) return undefined;
  const { code } = reason;
  const fromHost = reason.layer === 'host';
  const base = [`code:${code}`, ...hopEvidence(candidate)];

  if (code === 'needs_input' || (code === 'needs_auth' && !fromHost) || code === 'aborted') return undefined;

  if (fromHost) {
    // A refused receive blocked this hop's own output; a refused send or call blocked what an upstream member produced.
    const receive = reason.stage === 'receive' && candidate.member !== '';
    // Only a content block names a member; `denied` and `needs_auth` refuse the call itself.
    const origin = receive || code !== 'guard_block' ? undefined : await traceOrigin(hops, index, source, share);
    const upstream = origin?.blamed;
    const member = receive ? candidate.member : upstream?.member;
    const tail = receive ? ['stage:receive'] : upstream ? [`upstream:${upstream.hopId}`, ...origin.echoes] : origin ? [...origin.echoes, 'origin:input'] : [];
    return {
      layer: 'host',
      hopId: candidate.hopId,
      ...(member ? { member } : {}),
      confidence: CONFIDENCE.high,
      evidence: [...base, 'layer:host', ...tail],
    };
  }

  if (code === 'hop_limit') {
    const routed = Boolean(candidate.route?.member);
    return { layer: routed ? 'routing' : 'topology', hopId: candidate.hopId, confidence: CONFIDENCE.high, evidence: base };
  }

  if (code === 'timeout' || code === 'limit') {
    // The system's own limit or deadline stopped the call: no member is to blame.
    if (reason.layer === 'topology') {
      return { layer: 'topology', hopId: candidate.hopId, confidence: CONFIDENCE.high, evidence: [...base, 'layer:topology', ...(reason.by ? [`by:${reason.by}`] : [])] };
    }
    const spender = biggestSpender(hops, code) ?? candidate;
    return {
      layer: 'member',
      ...at(spender),
      confidence: CONFIDENCE.medium,
      evidence: [...base, ...(spender === candidate ? [] : [`spent:${spender.hopId}`])],
      layerFrom: spender,
      ...(spender === candidate ? { reason } : {}),
    };
  }

  if (reason.layer === 'topology') return { layer: 'topology', hopId: candidate.hopId, confidence: CONFIDENCE.medium, evidence: [...base, 'layer:topology'] };

  if (code === 'rejected') return { layer: 'member', ...at(candidate), confidence: CONFIDENCE.low, evidence: base, layerFrom: candidate, reason };

  let evidence = base;
  if (code === 'guard_block') {
    const origin = await traceOrigin(hops, index, source, share);
    const upstream = origin?.blamed;
    if (upstream) {
      return { layer: 'member', ...at(upstream), confidence: CONFIDENCE.medium, evidence: [...base, `upstream:${upstream.hopId}`, ...origin.echoes], layerFrom: upstream, reason };
    }
    if (origin) evidence = [...base, ...origin.echoes, 'origin:input'];
  }

  // guard_block traced to the input or without upstream, failed, error, and codes this adapter does not know: the hop itself.
  return { layer: 'member', ...at(candidate), confidence: CONFIDENCE.high, evidence, layerFrom: candidate, reason, graded: true };
}

/** The member's own name for where it failed: the first failed span with a layer, else the reason's layer. */
async function memberLayerOf(finding: Finding, source: RecordSource | undefined): Promise<string | undefined> {
  const hop = finding.layerFrom;
  if (hop && source?.spans) {
    try {
      const spans = await source.spans(hop.hopId);
      const failed = spans.find((s) => (s.status === 'error' || s.status === 'failed') && typeof s.layer === 'string' && s.layer !== '');
      if (failed?.layer) return failed.layer;
    } catch {
      // Spans are optional insight; the record alone is enough.
    }
  }
  const own = finding.reason?.layer;
  return own && !isLayer(own) && own !== 'host' ? own : undefined;
}

/** Deterministic attribution over the hop record. */
export function createRuleAttribution(options: RuleAttributionOptions = {}, ctx: Pick<AdapterContext, 'name'>): AttributionPort {
  const echoShare = options.echoShare ?? DEFAULT_ECHO_SHARE;
  return {
    name: ctx.name,
    async attribute({ record, scores, source }: AttributionInput): Promise<Attribution[]> {
      const hops = live(record);
      const candidate = findCandidate(hops, scores);
      let finding: Finding | undefined;

      if (candidate) {
        if (candidate.status === 'completed') {
          // Completed, but the case expected something else of this member.
          finding = { layer: 'member', ...at(candidate), confidence: CONFIDENCE.medium, evidence: ['expectation:member', ...hopEvidence(candidate)], layerFrom: candidate };
        } else if (routeChoseNothing(candidate)) {
          finding = { layer: 'routing', hopId: candidate.hopId, confidence: CONFIDENCE.high, evidence: ['route:none', ...hopEvidence(candidate)] };
        } else {
          finding = await byStopCode(candidate, hops.indexOf(candidate), hops, source, echoShare);
        }
      } else {
        const failed = scores.find((s) => s.value < 1);
        const last = [...hops].reverse().find((h) => h.status === 'completed' && h.member !== '');
        if (failed && last) {
          finding = { layer: 'member', ...at(last), confidence: CONFIDENCE.low, evidence: [`score:${failed.metric}`, ...hopEvidence(last)] };
        }
      }

      if (!finding) return [];
      const memberLayer = finding.layer === 'member' ? await memberLayerOf(finding, source) : undefined;
      const attribution: Attribution = {
        layer: finding.layer,
        confidence: finding.graded ? (memberLayer ? CONFIDENCE.high : CONFIDENCE.medium) : finding.confidence,
        evidence: finding.evidence,
        by: ADAPTER_NAME,
      };
      if (finding.member) attribution.member = finding.member;
      if (finding.hopId) attribution.hopId = finding.hopId;
      if (memberLayer) attribution.memberLayer = memberLayer;
      return [attribution];
    },
  };
}

export const adapter = defineAdapter<'AttributionPort', RuleAttributionOptions>({
  fills: 'AttributionPort',
  name: ADAPTER_NAME,
  maps: { technology: 'deterministic rules on hop records' },
  portVersion: PORT_VERSIONS.AttributionPort,
  tiers: ['prototype', 'production'],
  description: 'Names the layer and member behind a failed run from stop codes, expectations and member spans.',
  optionsSchema: { type: 'object', properties: { echoShare: { type: 'number', exclusiveMinimum: 0, maximum: 1 } }, additionalProperties: false },
  create: (options, ctx) => createRuleAttribution(options, ctx),
});

export const adapters = [adapter];
