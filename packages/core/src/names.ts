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
  executionKey: 'plexus.execution.key',
  errorMessage: 'plexus.error.message',
} as const;

export const EVENT = {
  limit: 'plexus.limit',
  partsDropped: 'plexus.parts.dropped',
  memberResumed: 'plexus.member.resumed',
  checkpointIgnored: 'plexus.checkpoint.ignored',
  /** A value the core keeps for a run (`run:*`) could not be written: carries the key and the error, never the value. */
  writeFailed: 'plexus.execution.write_failed',
  /** A resume found the wait's reply already delivered by an earlier invocation that did not finish: that reply is used. */
  replyKept: 'plexus.execution.reply_kept',
  /** A `waiting` result named no wait the run recorded: the run keeps the latest recorded wait. */
  waitInferred: 'plexus.execution.wait_inferred',
} as const;

export const METRIC = { hops: 'plexus.hops', attributions: 'plexus.attributions' } as const;
