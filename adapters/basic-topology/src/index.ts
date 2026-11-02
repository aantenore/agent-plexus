import {
  defineAdapter, PORT_VERSIONS,
  type BoundTopology, type CallOptions, type Condition, type MemberResult, type RouteDecision, type RunInput, type TopologyNode,
  type TopologyPort, type TopologySpec, type Usage,
} from '@agent-plexus/core';

const NAME = 'basic-topology';
const KINDS = ['sequence', 'route', 'loop', 'parallel', 'handoff', 'graph'] as const satisfies readonly TopologySpec['kind'][];

/** Where a node runs: the signal that can abort it, its budget share and the hops it made. */
interface Frame {
  signal?: AbortSignal;
  share?: number;
  hops?: string[];
}

const stopped = (code: string, layer: string, by?: string, detail?: string): MemberResult => ({
  status: 'stopped',
  output: '',
  reason: { code, layer, ...(by ? { by } : {}), ...(detail ? { detail } : {}) },
});

/** A route whose router or registry failed: not the same as a router that chose nobody. */
const routingFailed = (decision: RouteDecision): MemberResult => ({
  status: 'failed',
  output: '',
  reason: { code: 'error', layer: 'routing', ...(decision.reason ? { detail: decision.reason } : {}) },
});

/** Whether a condition names the `waiting` status: only then does an edge follow a run that waits. */
const namesWaiting = (condition: Condition): boolean =>
  condition.status === 'waiting' || (Array.isArray(condition.status) && condition.status.includes('waiting'));

/** `base` with usage and cost summed over `all`. */
function withTotals(base: MemberResult, all: readonly MemberResult[]): MemberResult {
  let usage: Usage | undefined;
  let costUsd: number | undefined;
  for (const r of all) {
    if (r.usage) usage = { inputTokens: (usage?.inputTokens ?? 0) + r.usage.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + r.usage.outputTokens };
    if (r.costUsd !== undefined) costUsd = (costUsd ?? 0) + r.costUsd;
  }
  const { usage: _usage, costUsd: _costUsd, ...rest } = base;
  return { ...rest, ...(usage ? { usage } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}

const isSpec = (node: TopologyNode): node is TopologySpec => typeof node === 'object' && node !== null;

/** Checks the spec before any run: supported kinds and the fields this adapter relies on. */
function validate(node: TopologyNode, path: string): void {
  if (typeof node === 'string') {
    if (!node) throw new TypeError(`${NAME}: node "${path}" has an empty member id`);
    return;
  }
  if (!isSpec(node)) throw new TypeError(`${NAME}: node "${path}" must be a member id or a topology spec`);
  const list = (items: unknown, field: string, each: (i: number) => string): void => {
    if (!Array.isArray(items) || items.length === 0) throw new TypeError(`${NAME}: node "${path}" (${node.kind}) needs a non-empty "${field}"`);
    items.forEach((item, i) => validate(item as TopologyNode, each(i)));
  };
  switch (node.kind) {
    case 'sequence':
      return list(node.steps, 'steps', (i) => `${path}.steps[${i}]`);
    case 'parallel':
      if (node.join !== undefined && node.join !== 'all' && node.join !== 'first') throw new TypeError(`${NAME}: node "${path}" has unknown join "${String(node.join)}"`);
      list(node.branches, 'branches', (i) => `${path}.branches[${i}]`);
      if (node.merge !== undefined) validate(node.merge, `${path}.merge`);
      return;
    case 'route':
      if (!node.candidates) throw new TypeError(`${NAME}: node "${path}" (route) needs "candidates"`);
      if (node.fallback !== undefined) validate(node.fallback, `${path}.fallback`);
      return;
    case 'loop':
      if (!node.until) throw new TypeError(`${NAME}: node "${path}" (loop) needs "until"`);
      if (node.maxIterations !== undefined && !(Number.isInteger(node.maxIterations) && node.maxIterations >= 1)) {
        throw new TypeError(`${NAME}: node "${path}" (loop) maxIterations must be an integer >= 1`);
      }
      return validate(node.body, `${path}.body`);
    case 'handoff':
      if (typeof node.start !== 'string' || !node.start) throw new TypeError(`${NAME}: node "${path}" (handoff) needs a "start" member id`);
      if (!Array.isArray(node.members) || node.members.length === 0 || node.members.some((m) => typeof m !== 'string' || !m)) {
        throw new TypeError(`${NAME}: node "${path}" (handoff) needs a non-empty "members" list of member ids`);
      }
      if (node.maxHandoffs !== undefined && !(Number.isInteger(node.maxHandoffs) && node.maxHandoffs >= 1)) {
        throw new TypeError(`${NAME}: node "${path}" (handoff) maxHandoffs must be an integer >= 1`);
      }
      return;
    case 'graph': {
      const nodes = node.nodes as Record<string, TopologyNode> | undefined;
      const ids = nodes && typeof nodes === 'object' ? Object.keys(nodes) : [];
      if (ids.length === 0) throw new TypeError(`${NAME}: node "${path}" (graph) needs a non-empty "nodes"`);
      const known = (id: unknown, where: string): void => {
        if (typeof id !== 'string' || !ids.includes(id)) throw new TypeError(`${NAME}: node "${path}" (graph) ${where} names unknown node "${String(id)}"`);
      };
      known(node.start, '"start"');
      if (!Array.isArray(node.edges)) throw new TypeError(`${NAME}: node "${path}" (graph) needs an "edges" list`);
      if (!Array.isArray(node.end)) throw new TypeError(`${NAME}: node "${path}" (graph) needs an "end" list`);
      node.edges.forEach((edge, i) => {
        known(edge?.from, `edges[${i}].from`);
        known(edge?.to, `edges[${i}].to`);
      });
      node.end.forEach((id, i) => known(id, `end[${i}]`));
      for (const id of ids) validate((nodes as Record<string, TopologyNode>)[id] as TopologyNode, `${path}.nodes.${id}`);
      return;
    }
    default:
      throw new TypeError(`${NAME}: node "${path}" has kind "${String((node as { kind: unknown }).kind)}", which this adapter does not support (supported: ${KINDS.join(', ')})`);
  }
}

function bindRun(spec: TopologySpec): BoundTopology {
  return {
    run: (input, scope) => {
      const aborted = (frame: Frame): boolean => scope.ctx.signal?.aborted === true || frame.signal?.aborted === true;
      const abortedResult = (): MemberResult => stopped('aborted', 'topology', NAME);

      async function member(id: string, path: string, input: RunInput, frame: Frame, route?: CallOptions['route']): Promise<MemberResult> {
        if (aborted(frame)) return abortedResult();
        const options: CallOptions = { node: path };
        if (frame.share !== undefined) options.share = frame.share;
        if (frame.signal) options.signal = frame.signal;
        if (route) options.route = route;
        const outcome = await scope.call(id, input, options);
        frame.hops?.push(outcome.hopId);
        return outcome.result;
      }

      async function node(n: TopologyNode, path: string, incoming: RunInput, frame: Frame): Promise<MemberResult> {
        if (typeof n === 'string') return member(n, path, incoming, frame);
        if (aborted(frame)) return abortedResult();
        const input = n.input === 'original' ? scope.input : incoming;
        switch (n.kind) {
          case 'sequence': return sequence(n, path, input, frame);
          case 'route': return route(n, path, input, frame);
          case 'loop': return loop(n, path, input, frame);
          case 'parallel': return parallel(n, path, input, frame);
          case 'handoff': return handoff(n, path, input, frame);
          case 'graph': return graph(n, path, input, frame);
          default: throw new TypeError(`${NAME}: node "${path}" has unsupported kind "${n.kind}"`);
        }
      }

      async function sequence(n: Extract<TopologySpec, { kind: 'sequence' }>, path: string, input: RunInput, frame: Frame): Promise<MemberResult> {
        const results: MemberResult[] = [];
        let current = input;
        for (let i = 0; i < n.steps.length; i++) {
          const result = await node(n.steps[i] as TopologyNode, `${path}.steps[${i}]`, current, frame);
          results.push(result);
          if (result.status !== 'completed') return withTotals(result, results);
          current = result.output;
        }
        return withTotals(results[results.length - 1] as MemberResult, results);
      }

      async function route(n: Extract<TopologySpec, { kind: 'route' }>, path: string, input: RunInput, frame: Frame): Promise<MemberResult> {
        const decision = await scope.route({ input, candidates: n.candidates, ...(n.router !== undefined ? { router: n.router } : {}), node: path });
        if (decision.member) {
          const chosen = { member: decision.member, ...(decision.ranked ? { ranked: decision.ranked } : {}) };
          return member(decision.member, path, input, frame, chosen);
        }
        if (n.fallback !== undefined) return node(n.fallback, `${path}.fallback`, input, frame);
        return decision.failed ? routingFailed(decision) : stopped('rejected', 'routing');
      }

      async function loop(n: Extract<TopologySpec, { kind: 'loop' }>, path: string, input: RunInput, frame: Frame): Promise<MemberResult> {
        const max = n.maxIterations ?? scope.limits.maxIterations;
        const results: MemberResult[] = [];
        let current = input;
        for (let iteration = 1; iteration <= max; iteration++) {
          const result = await node(n.body, `${path}.body#${iteration}`, current, frame);
          results.push(result);
          if (result.status !== 'completed' || scope.matches(n.until, result)) return withTotals(result, results);
          current = result.output;
        }
        const last = results[results.length - 1] as MemberResult;
        const by = n.maxIterations === undefined ? 'limits.system.maxIterations' : `${path}.maxIterations`;
        return withTotals({ ...last, status: 'stopped', reason: { code: 'limit', layer: 'topology', by } }, results);
      }

      async function handoff(n: Extract<TopologySpec, { kind: 'handoff' }>, path: string, input: RunInput, frame: Frame): Promise<MemberResult> {
        const max = n.maxHandoffs ?? scope.limits.maxHandoffs;
        const turnPath = (turn: number): string => `${path}.turns[${turn}]`;
        const results: MemberResult[] = [];
        let current = n.start;
        let incoming = input;
        let chosen: CallOptions['route'];
        for (let turn = 0; ; turn++) {
          const result = await member(current, turnPath(turn), incoming, frame, chosen);
          results.push(result);
          if (result.status !== 'completed') return withTotals(result, results);

          let next: string | undefined;
          chosen = undefined;
          const named = result.ext?.handoff;
          if (named !== undefined) {
            if (typeof named !== 'string' || !n.members.includes(named)) {
              return withTotals(stopped('rejected', 'topology', undefined, `handoff to "${String(named)}", which is not a member of ${path}`), results);
            }
            next = named;
          } else if (n.router !== undefined) {
            const candidates = n.members.filter((m) => m !== current);
            const decision: RouteDecision = candidates.length > 0 ? await scope.route({ input: result.output, candidates, router: n.router, node: turnPath(turn + 1), optional: true }) : {};
            // A router that chose nobody ends the handoff; one that failed stops it.
            if (decision.failed) return withTotals(routingFailed(decision), results);
            if (decision.member) {
              next = decision.member;
              chosen = { member: decision.member, ...(decision.ranked ? { ranked: decision.ranked } : {}) };
            }
          }
          if (next === undefined) return withTotals(result, results);
          if (turn + 1 > max) {
            const by = n.maxHandoffs === undefined ? 'limits.system.maxHandoffs' : `${path}.maxHandoffs`;
            return withTotals({ ...result, status: 'stopped', reason: { code: 'limit', layer: 'topology', by } }, results);
          }
          current = next;
          incoming = result.output;
        }
      }

      async function graph(n: Extract<TopologySpec, { kind: 'graph' }>, path: string, input: RunInput, frame: Frame): Promise<MemberResult> {
        const max = scope.limits.maxIterations;
        const visits = new Map<string, number>();
        const results: MemberResult[] = [];
        let id = n.start;
        let incoming = input;
        for (;;) {
          const visit = (visits.get(id) ?? 0) + 1;
          if (visit > max) {
            const last = results[results.length - 1] as MemberResult;
            return withTotals({ ...last, status: 'stopped', reason: { code: 'limit', layer: 'topology', by: 'limits.system.maxIterations' } }, results);
          }
          visits.set(id, visit);
          const result = await node(n.nodes[id] as TopologyNode, `${path}.nodes.${id}${visit > 1 ? `#${visit}` : ''}`, incoming, frame);
          results.push(result);
          const completed = result.status === 'completed';
          // A waiting result follows only an edge whose condition names `waiting`; otherwise the graph waits with it.
          const follows = (when: Condition): boolean => (result.status !== 'waiting' || namesWaiting(when)) && scope.matches(when, result);
          const edge = n.edges.find((e) => e.from === id && (e.when ? follows(e.when) : completed));
          if (edge) {
            id = edge.to;
            incoming = result.output;
            continue;
          }
          if (!completed || n.end.includes(id)) return withTotals(result, results);
          return withTotals(stopped('rejected', 'topology', undefined, `graph node ${id} has no edge for this result`), results);
        }
      }

      async function parallel(n: Extract<TopologySpec, { kind: 'parallel' }>, path: string, input: RunInput, frame: Frame): Promise<MemberResult> {
        const count = n.branches.length;
        const first = n.join === 'first';
        const share = (frame.share ?? 1) / count;
        const controller = new AbortController();
        const signal = frame.signal ? AbortSignal.any([frame.signal, controller.signal]) : controller.signal;
        const results: (MemberResult | undefined)[] = new Array(count).fill(undefined);
        const hops: string[][] = n.branches.map(() => []);
        let next = 0;
        let winner = -1;
        let inflight: number[] = [];
        const running = new Set<number>();
        let failure: { error: unknown } | undefined;

        const worker = async (): Promise<void> => {
          while (winner < 0 && !failure) {
            const i = next++;
            if (i >= count) return;
            running.add(i);
            try {
              const branchFrame: Frame = { share, hops: hops[i] as string[], signal };
              const result = await node(n.branches[i] as TopologyNode, `${path}.branches[${i}]`, input, branchFrame);
              results[i] = result;
              if (first && winner < 0 && result.status === 'completed') {
                winner = i;
                inflight = results.flatMap((r, j) => (j !== i && j < next && r === undefined ? [j] : []));
                controller.abort();
              }
            } catch (error) {
              if (!failure && winner < 0) inflight = [...running].filter((j) => j !== i);
              failure ??= { error };
              controller.abort();
            } finally {
              running.delete(i);
            }
          }
        };
        const width = Math.max(1, Math.min(scope.limits.maxParallel, count));
        await Promise.all(Array.from({ length: width }, worker));
        for (const i of inflight) for (const hopId of hops[i] as string[]) scope.abandon(hopId);
        frame.hops?.push(...hops.flat());
        if (failure) throw failure.error;

        const done = results.filter((r): r is MemberResult => r !== undefined);
        if (first && winner >= 0) return withTotals(results[winner] as MemberResult, done);
        const bad = done.find((r) => r.status !== 'completed');
        if (bad) return withTotals(bad, done);
        const label = (i: number): string => {
          const b = n.branches[i] as TopologyNode;
          return typeof b === 'string' ? b : `${path}.branches[${i}]`;
        };
        const joined = results.map((r, i) => `[${label(i)}]\n${(r as MemberResult).output}`).join('\n\n');
        if (n.merge === undefined) return withTotals({ status: 'completed', output: joined }, done);
        const mergeFrame: Frame = {};
        if (frame.signal) mergeFrame.signal = frame.signal;
        if (frame.share !== undefined) mergeFrame.share = frame.share;
        if (frame.hops) mergeFrame.hops = frame.hops;
        const merged = await node(n.merge, `${path}.merge`, joined, mergeFrame);
        return withTotals(merged, [...done, merged]);
      }

      const rootFrame: Frame = {};
      return node(spec, 'root', input, rootFrame);
    },
  };
}

/** Topology that runs sequence, route, loop, parallel, handoff and graph nodes in process. */
export function createBasicTopology(name = NAME): TopologyPort {
  return {
    name,
    kinds: KINDS,
    bind(spec) {
      validate(spec, 'root');
      return bindRun(spec);
    },
  };
}

export const adapter = defineAdapter<'TopologyPort'>({
  fills: 'TopologyPort',
  name: NAME,
  maps: { technology: 'in-process topology executor' },
  portVersion: PORT_VERSIONS.TopologyPort,
  tiers: ['prototype', 'production'],
  description: 'Runs sequence, route, loop, parallel, handoff and graph topologies in process, reaching members only through the run scope.',
  optionsSchema: { type: 'object', properties: {}, additionalProperties: false },
  create: (_options, ctx) => createBasicTopology(ctx.name),
});

export const adapters = [adapter];
