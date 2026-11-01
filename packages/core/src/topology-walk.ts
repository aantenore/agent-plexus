import type { TopologyNode } from './shapes.ts';

/** Child nodes of a topology node with their paths (`root.steps[1]`); member ids have none. */
export function childNodes(node: TopologyNode, path: string): [TopologyNode, string][] {
  if (typeof node === 'string') return [];
  switch (node.kind) {
    case 'sequence': return node.steps.map((n, i) => [n, `${path}.steps[${i}]`]);
    case 'parallel': return [...node.branches.map((n, i): [TopologyNode, string] => [n, `${path}.branches[${i}]`]), ...(node.merge !== undefined ? [[node.merge, `${path}.merge`] as [TopologyNode, string]] : [])];
    case 'route': return node.fallback !== undefined ? [[node.fallback, `${path}.fallback`]] : [];
    case 'loop': return [[node.body, `${path}.body`]];
    case 'graph': return Object.entries(node.nodes).map(([id, n]) => [n, `${path}.nodes.${id}`]);
    default: return [];
  }
}

/** Visits a node and every node below it, depth first, with its path. */
export function walkTopology(node: TopologyNode, visit: (node: TopologyNode, path: string) => void, path = 'root'): void {
  visit(node, path);
  for (const [child, childPath] of childNodes(node, path)) walkTopology(child, visit, childPath);
}
