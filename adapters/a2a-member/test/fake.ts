import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MemberCallContext } from '@agent-plexus/core';

/** One JSON-RPC request the fake server received. */
export interface Rpc {
  method: string;
  params: any;
  headers: IncomingMessage['headers'];
}

export type RpcHandler = (rpc: Rpc) => unknown | Promise<unknown>;

/** Thrown by a handler to answer with a JSON-RPC error. */
export class RpcError extends Error {
  code: number;
  constructor(code: number, message = 'error') {
    super(message);
    this.code = code;
  }
}

export interface Fake {
  /** Origin, e.g. `http://127.0.0.1:41234`. */
  origin: string;
  cardUrl: string;
  rpcUrl: string;
  /** Every JSON-RPC request, in order. */
  calls: Rpc[];
  /** Number of GET requests per path, and the headers of each. */
  gets: Record<string, number>;
  getHeaders: IncomingMessage['headers'][];
  /** Replaced by tests: the JSON-RPC handler, the card and extra documents by path. */
  rpc: RpcHandler;
  card: Record<string, unknown>;
  documents: Record<string, unknown>;
  /** Status and body the RPC endpoint answers with instead of the handler, when set. */
  failWith?: { status: number; body: string };
  methods(): string[];
  close(): Promise<void>;
}

export const card = (origin: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Billing agent',
  description: 'Answers billing questions',
  version: '1.2.0',
  supportedInterfaces: [{ url: `${origin}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'invoices', name: 'Invoices', description: 'Looks up invoices', tags: ['billing', 'invoices'] }],
  ...extra,
});

export const text = (value: string) => ({ parts: [{ text: value }] });

/** A task in the 1.0 wire shape. */
export function task(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'task-1', contextId: 'ctx-1', status: { state: `TASK_STATE_${state}` }, ...extra };
}

export const answer = (value: string) => [{ artifactId: 'a1', parts: [{ text: value }] }];
export const statusMessage = (value: string) => ({ messageId: 'm1', role: 'ROLE_AGENT', parts: [{ text: value }] });

/** A fake A2A agent over node:http, 127.0.0.1 only. The default handler answers every request with a completed task. */
export async function startFake(rpc?: RpcHandler): Promise<Fake> {
  const gets: Record<string, number> = {};
  const fake: Fake = {
    origin: '',
    cardUrl: '',
    rpcUrl: '',
    calls: [],
    gets,
    getHeaders: [],
    rpc: rpc ?? (() => ({ task: task('COMPLETED', { artifacts: answer('done') }) })),
    card: {},
    documents: {},
    methods: () => fake.calls.map((c) => c.method),
    close: () => closeServer(server),
  };
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'GET') {
      gets[path] = (gets[path] ?? 0) + 1;
      fake.getHeaders.push(req.headers);
      if (path === '/.well-known/agent-card.json') return json(res, fake.card);
      if (path === '/redirect/agent-card.json') {
        res.writeHead(302, { location: '/.well-known/agent-card.json' }).end();
        return;
      }
      if (path in fake.documents) return json(res, fake.documents[path]);
      res.writeHead(404).end();
      return;
    }
    if (path === '/redirect-rpc') {
      res.writeHead(307, { location: '/rpc' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string; params: unknown };
    fake.calls.push({ method: body.method, params: body.params, headers: req.headers });
    if (fake.failWith) {
      res.writeHead(fake.failWith.status, { 'content-type': 'text/plain' }).end(fake.failWith.body);
      return;
    }
    try {
      const result = await fake.rpc(fake.calls[fake.calls.length - 1]!);
      json(res, { jsonrpc: '2.0', id: body.id, result });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603;
      json(res, { jsonrpc: '2.0', id: body.id, error: { code, message: 'error' } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.cardUrl = `${fake.origin}/.well-known/agent-card.json`;
  fake.rpcUrl = `${fake.origin}/rpc`;
  fake.card = card(fake.origin);
  return fake;
}

function json(res: import('node:http').ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export interface CallOptions extends Partial<MemberCallContext> {
  remainingMs?: number;
}

/** A member call context; `checkpoints` collects every taskRef the member journals. */
export function callContext(extra: CallOptions = {}): MemberCallContext & { checkpoints: string[] } {
  const { remainingMs, ...rest } = extra;
  const checkpoints: string[] = [];
  return {
    runId: 'run-1',
    system: 'desk',
    hopId: 'hop-1',
    outbound: { remainingMs: remainingMs ?? 60_000, hops: 1, maxHops: 3, rootRunId: 'root-1', parentRunId: 'run-1' },
    checkpoint: async (ref: string) => {
      checkpoints.push(ref);
    },
    checkpoints,
    ...rest,
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
