/** Telemetry names emitted through the host's telemetry hook. Every span carries `plexus.layer`. */
export const SPAN = { run: 'plexus.run', node: 'plexus.node', hop: 'plexus.hop', route: 'plexus.route' } as const;

export const ATTR = {
  layer: 'plexus.layer',
  system: 'plexus.system',
  member: 'plexus.member',
  hop: 'plexus.hop',
  nodePath: 'plexus.node.path',
  nodeKind: 'plexus.node.kind',
  routeChoice: 'plexus.route.choice',
  runStatus: 'plexus.run.status',
  runReason: 'plexus.run.reason',
  partsCount: 'plexus.parts.count',
} as const;

export const EVENT = {
  limit: 'plexus.limit',
  partsDropped: 'plexus.parts.dropped',
  memberResumed: 'plexus.member.resumed',
  checkpointIgnored: 'plexus.checkpoint.ignored',
} as const;

export const METRIC = { hops: 'plexus.hops', attributions: 'plexus.attributions' } as const;
