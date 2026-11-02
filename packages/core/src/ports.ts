/** The six ports. Each is owner-defined, thin and versioned on its own (PORT_VERSIONS). */
import type { Host } from './hooks.ts';
import type {
  AgentEntry, Attribution, CandidateFilter, Caller, HopRecord, MemberResult, OutboundBounds, RouteDecision,
  RouteQuestion, RunContext, RunInput, Score, TopologySpec,
} from './shapes.ts';

export const PORT_VERSIONS = {
  MemberPort: '0.1.0',
  RegistryPort: '0.1.0',
  AgentRouterPort: '0.1.0',
  TopologyPort: '0.1.0',
  ExecutionPort: '0.1.0',
  AttributionPort: '0.1.0',
} as const;
export type PortName = keyof typeof PORT_VERSIONS;

// L0 member ---------------------------------------------------------------------------------------------------------

/** What a member call receives beyond the run context. */
export interface MemberCallContext extends RunContext {
  hopId: string;
  /** From the host's gate, for the member's audience. Never the caller's own credential. */
  credential?: string;
  outbound: OutboundBounds;
  /**
   * Journals the handle of remote work (a task id) as soon as the member has one, so a restart resumes that work
   * through `resume` instead of sending the request again.
   */
  checkpoint(taskRef: string): Promise<void>;
}

/** One configured member: how to describe it and how to call it. */
export interface MemberPort {
  name: string;
  describe(): Promise<AgentEntry>;
  invoke(input: RunInput, ctx: MemberCallContext): Promise<MemberResult>;
  /** Continues remote work: waits for it when `input` is undefined, or sends the input a waiting member asked for. */
  resume?(taskRef: string, input: RunInput | undefined, ctx: MemberCallContext): Promise<MemberResult>;
  cancel?(taskRef: string, ctx: MemberCallContext): Promise<void>;
  native?(): unknown;
}

// L1 registry -------------------------------------------------------------------------------------------------------

export interface RegistryPort {
  name: string;
  list(filter?: CandidateFilter): Promise<AgentEntry[]>;
  get(id: string): Promise<AgentEntry | undefined>;
}

// L2 routing --------------------------------------------------------------------------------------------------------

export interface AgentRouterPort {
  name: string;
  route(question: RouteQuestion, ctx: RunContext): Promise<RouteDecision>;
}

// L3 topology -------------------------------------------------------------------------------------------------------

export interface CallOptions {
  /** Topology path of the calling node, e.g. `root.steps[1]`. */
  node: string;
  parentHopId?: string;
  /** Fraction of the remaining budget to reserve (parallel branches); default: everything not reserved. */
  share?: number;
  signal?: AbortSignal;
  /** The router's decision that chose this member, kept in the hop record. */
  route?: Omit<RouteDecision, 'reason'>;
}

export interface CallOutcome {
  hopId: string;
  result: MemberResult;
}

export interface RouteRequest {
  input: RunInput;
  candidates: string[] | CandidateFilter;
  router?: string;
  node: string;
}

/** Limits a topology must respect; the core enforces maxSteps, time and hops itself in `call`. */
export interface TopologyLimits {
  maxParallel: number;
  maxIterations: number;
  maxHandoffs: number;
}

/**
 * What the core gives a topology for one run. `call` is the memberCall pipeline: a topology reaches members only
 * through it. `route` asks the AgentRouterPort; `matches` evaluates a Condition.
 */
export interface RunScope {
  ctx: RunContext;
  input: RunInput;
  limits: TopologyLimits;
  call(member: string, input: RunInput, options: CallOptions): Promise<CallOutcome>;
  route(request: RouteRequest): Promise<RouteDecision>;
  matches(condition: import('./shapes.ts').Condition, result: MemberResult): boolean;
  /** Marks a hop abandoned (a `parallel` with `join: "first"`), so attribution skips it. */
  abandon(hopId: string): void;
}

export interface BoundTopology {
  run(input: RunInput, scope: RunScope): Promise<MemberResult>;
}

export interface TopologyInfo {
  system: string;
  members: string[];
}

export interface TopologyPort {
  name: string;
  /** Kinds this adapter can run; `check` refuses a topology that uses others. */
  kinds: readonly TopologySpec['kind'][];
  bind(spec: TopologySpec, info: TopologyInfo): BoundTopology | Promise<BoundTopology>;
}

// L4 execution ------------------------------------------------------------------------------------------------------

export interface Execution {
  runKey: string;
  /** Runs `fn` once; on resume returns its stored result. Results must be JSON-serialisable. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Suspends until `signal(runKey, name, value)` or `untilAt`; returns the value, or undefined at the deadline. */
  wait(name: string, untilAt: string): Promise<unknown>;
  /** Stores a text and returns its key, so records reference texts instead of carrying them. */
  put(text: string): Promise<string>;
  /** Keeps a small JSON value under a key for this run (a remote task handle), surviving a restart when durable. */
  remember(key: string, value: unknown): Promise<void>;
  /** The value kept under a key, or undefined. */
  recall(key: string): Promise<unknown>;
  end(status: MemberResult['status']): Promise<void>;
}

export interface ExecutionPort {
  name: string;
  /** Durable adapters resume an existing run with the same key. */
  begin(runKey: string): Promise<Execution>;
  signal(runKey: string, name: string, value: unknown): Promise<void>;
  /** Reads a stored text by key (for attribution and replay). */
  read?(key: string): Promise<string | undefined>;
}

// L5 attribution ----------------------------------------------------------------------------------------------------

export interface MemberSpan {
  name: string;
  layer?: string;
  status?: string;
  attrs?: Record<string, unknown>;
}

/** Where attribution reads records from, and the members' own spans when a trace backend has them. */
export interface RecordSource {
  name: string;
  records(rootRunId: string): Promise<HopRecord[]>;
  spans?(hopId: string): Promise<MemberSpan[]>;
  /** Reads a text stored in the execution journal by its key (`inputRef`, `outputRef`). */
  text?(key: string): Promise<string | undefined>;
}

export interface AttributionInput {
  record: HopRecord[];
  result: MemberResult;
  scores: Score[];
  source?: RecordSource;
}

export interface AttributionPort {
  name: string;
  attribute(input: AttributionInput): Promise<Attribution[]>;
}

export type { Caller, Host };
