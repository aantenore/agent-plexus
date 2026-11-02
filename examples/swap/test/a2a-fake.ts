import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal A2A 1.0 agent over node:http, 127.0.0.1 only: it serves its card and answers `SendMessage` with a settled
 * task. Reduced from the fake of the a2a-member tests (adapters/a2a-member/test/fake.ts, not exported).
 */
export interface FakeAgent {
  cardUrl: string;
  /** The text of every message received, in order. */
  received: string[];
  close(): Promise<void>;
}

/** What the agent does with one message: complete with an answer, or reject the task. */
export type Answer = (text: string) => { completed: string } | { rejected: true };

export async function startFakeAgent(answer: Answer, card: { name: string; description: string; tags: string[] }): Promise<FakeAgent> {
  const received: string[] = [];
  let origin = '';
  const server: Server = createServer(async (req, res) => {
    const json = (body: unknown): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'GET' && path === '/.well-known/agent-card.json') {
      return json({
        name: card.name,
        description: card.description,
        version: '1.0.0',
        supportedInterfaces: [{ url: `${origin}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: {},
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [{ id: 'main', name: card.name, description: card.description, tags: card.tags }],
      });
    }
    if (req.method !== 'POST' || path !== '/rpc') return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string; params: { message?: { parts?: { text?: string }[] } } };
    if (body.method !== 'SendMessage') return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } });
    const text = (body.params.message?.parts ?? []).map((p) => p.text ?? '').join('');
    received.push(text);
    const outcome = answer(text);
    const task = 'completed' in outcome
      ? { status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'a1', parts: [{ text: outcome.completed }] }] }
      : { status: { state: 'TASK_STATE_REJECTED' } };
    json({ jsonrpc: '2.0', id: body.id, result: { task: { id: `task-${received.length}`, contextId: 'ctx-1', ...task } } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    cardUrl: `${origin}/.well-known/agent-card.json`,
    received,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
