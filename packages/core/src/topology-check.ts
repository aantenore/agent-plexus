import type { TopologyKind, TopologyNode } from './shapes.ts';
import { walkTopology } from './topology-walk.ts';

/** Router a `route` or `handoff` node uses when it names none. */
export const DEFAULT_ROUTER = 'router';

const KNOWN_KINDS: readonly TopologyKind[] = ['sequence', 'parallel', 'route', 'loop', 'handoff', 'supervise', 'graph'];

/** Nodes of a graph reachable from `start` along its edges. */
function reachable(start: string, edges: { from: string; to: string }[]): Set<string> {
  const seen = new Set<string>([start]);
  for (const queue = [start]; queue.length;) {
    const from = queue.pop()!;
    for (const e of edges) if (e.from === from && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
  }
  return seen;
}

/**
 * Structural problems of a topology against the configured members and routers and the kinds the topology adapter
 * runs: unknown members and routers, unsupported kinds, graph nodes that do not exist, an end no edge leads to.
 */
export function topologyProblems(spec: TopologyNode, members: string[], supportedKinds: readonly TopologyKind[], routers: string[]): string[] {
  const out: string[] = [];
  const member = (id: string, path: string) => { if (!members.includes(id)) out.push(`${path}: unknown member "${id}"`); };
  const router = (id: string | undefined, path: string) => {
    const name = id ?? DEFAULT_ROUTER;
    if (!routers.includes(name)) out.push(`${path}: unknown router "${name}"`);
  };
  walkTopology(spec, (node, path) => {
    if (typeof node === 'string') return member(node, path);
    if (!KNOWN_KINDS.includes(node.kind)) return void out.push(`${path}: unknown kind "${String(node.kind)}"`);
    if (!supportedKinds.includes(node.kind)) out.push(`${path}: kind "${node.kind}" is not supported by the topology adapter`);
    switch (node.kind) {
      case 'route':
        if (Array.isArray(node.candidates)) for (const id of node.candidates) member(id, `${path}.candidates`);
        router(node.router, path);
        break;
      case 'handoff':
        member(node.start, `${path}.start`);
        for (const id of node.members) member(id, `${path}.members`);
        router(node.router, path);
        break;
      case 'supervise':
        member(node.supervisor, `${path}.supervisor`);
        for (const id of node.members) member(id, `${path}.members`);
        break;
      case 'graph': {
        const ids = Object.keys(node.nodes);
        const graphNode = (id: string, where: string) => { if (!ids.includes(id)) out.push(`${where}: unknown graph node "${id}"`); };
        graphNode(node.start, `${path}.start`);
        for (const id of node.end) graphNode(id, `${path}.end`);
        node.edges.forEach((e, i) => { graphNode(e.from, `${path}.edges[${i}].from`); graphNode(e.to, `${path}.edges[${i}].to`); });
        const seen = reachable(node.start, node.edges);
        for (const id of node.end) if (ids.includes(id) && !seen.has(id)) out.push(`${path}.end: "${id}" is not reachable from "${node.start}"`);
        break;
      }
      default:
    }
  });
  return out;
}
