import {
  defineAdapter, inputText, PORT_VERSIONS,
  type BoundTopology, type MemberResult, type RunInput, type RunScope, type TopologyNode, type TopologyPort, type TopologySpec,
} from '@agent-plexus/core';

const NAME = 'linear-topology';

/** The only kinds this executor runs. */
const KINDS = ['sequence', 'route'] as const satisfies readonly TopologySpec['kind'][];

const isSupported = (kind: string): boolean => (KINDS as readonly string[]).includes(kind);

/** Refuses at bind time a node this executor cannot run, so a bad topology never reaches a run. */
function ensureRunnable(node: TopologyNode, path: string): void {
  if (typeof node === 'string') return;
  if (!isSupported(node.kind)) throw new TypeError(`${NAME}: node "${path}" has kind "${node.kind}"; supported: ${KINDS.join(', ')}`);
  if (node.kind === 'sequence') node.steps.forEach((step, i) => ensureRunnable(step, `${path}.steps[${i}]`));
  if (node.kind === 'route' && node.fallback !== undefined) ensureRunnable(node.fallback, `${path}.fallback`);
}

/** Runs `node` with `incoming` as its input and returns its result. */
async function walk(scope: RunScope, node: TopologyNode, path: string, incoming: RunInput): Promise<MemberResult> {
  if (typeof node === 'string') return (await scope.call(node, incoming, { node: path })).result;
  const input = node.input === 'original' ? scope.input : incoming;
  if (node.kind === 'sequence') {
    let last: MemberResult = { status: 'completed', output: inputText(input) };
    let current = input;
    for (const [i, step] of node.steps.entries()) {
      last = await walk(scope, step, `${path}.steps[${i}]`, current);
      if (last.status !== 'completed') return last;
      current = last.output;
    }
    return last;
  }
  if (node.kind === 'route') {
    const decision = await scope.route({ input, candidates: node.candidates, ...(node.router !== undefined ? { router: node.router } : {}), node: path });
    if (decision.member !== undefined) {
      const route = { member: decision.member, ...(decision.ranked ? { ranked: decision.ranked } : {}) };
      return (await scope.call(decision.member, input, { node: path, route })).result;
    }
    if (node.fallback !== undefined) return walk(scope, node.fallback, `${path}.fallback`, input);
    return { status: 'stopped', output: '', reason: { code: 'rejected', layer: 'routing' } };
  }
  throw new TypeError(`${NAME}: node "${path}" has unsupported kind "${(node as { kind: string }).kind}"`);
}

/** Topology that runs sequence and route nodes, one after the other, and nothing else. */
export function createLinearTopology(name: string = NAME): TopologyPort {
  return {
    name,
    kinds: KINDS,
    bind(spec): BoundTopology {
      ensureRunnable(spec, 'root');
      return { run: (input, scope) => walk(scope, spec, 'root', input) };
    },
  };
}

export const adapter = defineAdapter<'TopologyPort'>({
  fills: 'TopologyPort',
  name: NAME,
  maps: { technology: 'minimal sequential executor' },
  portVersion: PORT_VERSIONS.TopologyPort,
  tiers: ['prototype', 'production'],
  description: 'Runs sequence and route topologies, nothing else; a topology with another kind is refused by check.',
  optionsSchema: { type: 'object', properties: {}, additionalProperties: false },
  create: (_options, ctx) => createLinearTopology(ctx.name),
});

export const adapters = [adapter];
