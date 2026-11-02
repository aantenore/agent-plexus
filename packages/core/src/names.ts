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
  /** `MemberPort.cancel` of an abandoned or aborted call threw or outlived `limits.system.cancelTimeoutMs`. */
  cancelFailed: 'plexus.member.cancel_failed',
  /** A member reported `usage` or `costUsd` that is not a finite non-negative number: the figure is dropped. */
  figureDropped: 'plexus.member.figure_dropped',
} as const;

/**
 * `ext` keys of the protocol between a member and the topology, in the reserved `plexus.` namespace: a member's result
 * names the member a `supervise` node delegates to (`{ member, input? }`) or a `handoff` node hands over to (a member
 * id). The bare `delegate` and `handoff` of 0.1.0 are deprecated.
 */
export const EXT_KEYS = { delegate: 'plexus.delegate', handoff: 'plexus.handoff' } as const;

/** The deprecated bare `ext` keys of 0.1.0, by the protocol key that replaces them. */
export const DEPRECATED_EXT_KEYS: Readonly<Record<string, string>> = { delegate: EXT_KEYS.delegate, handoff: EXT_KEYS.handoff };

export const METRIC = { hops: 'plexus.hops', attributions: 'plexus.attributions' } as const;
