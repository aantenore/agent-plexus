/**
 * The agent-plexus language: the shapes that cross its ports and hooks. Fixed and minimal; extra data goes in `ext`
 * under `<adapter>.<name>` keys, which the core copies and never reads. Run status and stop codes use values chosen to
 * match the common vocabularies of agent stacks, so an adapter maps them one to one.
 */
import type { AttributionLayer } from './layers.ts';

export type Ext = Record<string, unknown>;
export type Attrs = Record<string, string | number | boolean | string[]>;

export type Part = { type: 'text'; text: string } | { type: 'media'; mediaType: string; url?: string; data?: string };

/** What a system or a member receives. A string is shorthand for `{ text }`. */
export type RunInput = string | { text: string; parts?: Part[] };

/** The host's verified caller, carried through. The core reads only `id`, `kind` and `actors`. */
export interface Caller {
  id: string;
  kind: 'user' | 'agent';
  roles: string[];
  scopes: string[];
  name?: string;
  /** Agents that acted for the caller, first delegate first, as the host verified them. */
  actors?: { id: string; kind: 'user' | 'agent'; name?: string }[];
  /** In memory only: never serialised, logged or traced. */
  credential?: string;
  ext?: Ext;
}

/** Deadline, budget and hop count of a run. Carried across hops so every agent in a chain works within the same limits. */
export interface Bounds {
  /** ISO 8601, local clock. */
  deadlineAt: string;
  hops: number;
  maxHops: number;
  tokens?: number;
  costUsd?: number;
}

export interface Lineage {
  rootRunId: string;
  parentRunId: string;
}

/** What crosses to the next agent: time as remaining milliseconds, never as a clock time. */
export interface OutboundBounds {
  remainingMs: number;
  hops: number;
  maxHops: number;
  tokens?: number;
  costUsd?: number;
  rootRunId: string;
  parentRunId: string;
}

export interface RunContext {
  runId: string;
  system: string;
  caller?: Caller;
  /** Bounds the host passed in; the core tightens them with the system's own limits. */
  bounds?: Bounds;
  lineage?: Lineage;
  sessionId?: string;
  signal?: AbortSignal;
  /** Opaque to the core; owned by the telemetry hook. */
  trace?: { parent: string; state?: string };
}

export const RUN_STATUSES = ['completed', 'failed', 'stopped', 'waiting'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Core stop codes; config may add values that behave like one of them. */
export const STOP_CODES = ['guard_block', 'denied', 'aborted', 'timeout', 'limit', 'hop_limit', 'needs_input', 'needs_auth', 'rejected', 'error'] as const;
export type CoreStopCode = (typeof STOP_CODES)[number];
export type StopCode = CoreStopCode | (string & {});

export interface StopReason {
  /** The only field consumers branch on. */
  code: StopCode;
  /** Where it stopped: a plexus layer, `host`, or the member's own name for its layer. */
  layer?: string;
  /** Instance that stopped it. For people and telemetry, never branched on. */
  by?: string;
  /** For a gate check: whether it stopped what was sent to the member or what came back. */
  stage?: 'send' | 'receive';
  /** Internal text, never parsed, never shown to a caller. */
  detail?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface MemberResult {
  status: RunStatus;
  output: string;
  /** Required when `status` is not `completed`. */
  reason?: StopReason;
  runId?: string;
  /** Opaque handle to resume or cancel remote work. */
  taskRef?: string;
  usage?: Usage;
  costUsd?: number;
  ext?: Ext;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentEntry {
  id: string;
  name: string;
  description: string;
  skills: Skill[];
  /** `protocol` is a vocabulary (`function` is built in; adapters add their own). */
  endpoint: { protocol: string; url?: string; ref?: string };
  /** Credential audience; from config, never from a card. */
  audience?: string;
  attrs?: Attrs;
  trust: { signed: boolean; keyId?: string; pinned: boolean };
  version?: string;
  ext?: Ext;
}

export interface CandidateFilter {
  skills?: string[];
  tags?: string[];
  attrs?: Attrs;
}

export interface RouteQuestion {
  input: RunInput;
  candidates: AgentEntry[];
  caller?: Caller;
  bounds?: Bounds;
}

export interface RouteDecision {
  /** Absent: no candidate fits. */
  member?: string;
  ranked?: { member: string; score: number }[];
  /** Internal, never parsed. */
  reason?: string;
}

/** Declarative condition on a node's result; `fn` is `"<module>#<export>"`, a synchronous pure function. */
export interface Condition {
  status?: RunStatus | RunStatus[];
  code?: StopCode | StopCode[];
  ext?: Record<string, unknown>;
  /** Regular expression on the output. */
  matches?: string;
  fn?: string;
}

interface NodeBase {
  name?: string;
  /** What the node receives: the previous output (default) or the system's original input. */
  input?: 'output' | 'original';
  ext?: Ext;
}

/** A node is a member id or a nested topology. */
export type TopologyNode = string | TopologySpec;

export type TopologySpec =
  | (NodeBase & { kind: 'sequence'; steps: TopologyNode[] })
  | (NodeBase & { kind: 'parallel'; branches: TopologyNode[]; join?: 'all' | 'first'; merge?: TopologyNode })
  | (NodeBase & { kind: 'route'; candidates: string[] | CandidateFilter; router?: string; fallback?: TopologyNode })
  | (NodeBase & { kind: 'loop'; body: TopologyNode; until: Condition; maxIterations?: number })
  | (NodeBase & { kind: 'handoff'; start: string; members: string[]; router?: string; maxHandoffs?: number })
  | (NodeBase & { kind: 'supervise'; supervisor: string; members: string[] })
  | (NodeBase & { kind: 'graph'; nodes: Record<string, TopologyNode>; start: string; edges: { from: string; to: string; when?: Condition }[]; end: string[] });

export type TopologyKind = TopologySpec['kind'];

export interface HopRecord {
  hopId: string;
  parentHopId?: string;
  member: string;
  /** Topology path of the node that made the call, e.g. `root.steps[1]`. */
  node: string;
  runId?: string;
  rootRunId: string;
  hops: number;
  startedAt: string;
  durationMs: number;
  status: RunStatus;
  reason?: StopReason;
  usage?: Usage;
  costUsd?: number;
  route?: Omit<RouteDecision, 'reason'>;
  /** Keys of the texts in the execution journal; records never carry the texts. */
  inputRef?: string;
  outputRef?: string;
  /** True when the topology abandoned the branch (a `parallel` with `join: "first"`). */
  abandoned?: boolean;
}

export interface Score {
  metric: string;
  /** In [0, 1]. */
  value: number;
  /** A member id when the case set an expectation for one member. */
  member?: string;
  reason?: string;
}

export interface EvalCase {
  id: string;
  input: RunInput;
  expected?: { output?: { equals?: string; contains?: string; matches?: string }; members?: Record<string, { contains?: string; matches?: string; status?: RunStatus }> };
  tags?: string[];
}

export interface Attribution {
  layer: AttributionLayer;
  member?: string;
  /** The member's own name for where it failed (a layer id of the member's own stack, for instance). */
  memberLayer?: string;
  hopId?: string;
  /** In [0, 1]. */
  confidence: number;
  evidence: string[];
  /** The attribution adapter that produced it. */
  by: string;
}

/** A system's result is a member result plus its hop record, so a system can be a member of another. */
export interface SystemResult extends MemberResult {
  runId: string;
  record: HopRecord[];
}

export const inputText = (input: RunInput): string => (typeof input === 'string' ? input : input.text);
