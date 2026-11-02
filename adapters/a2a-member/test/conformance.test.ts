import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-plexus/conformance';
import { adapter } from '../src/index.ts';
import { answer, startFake, task, type Rpc } from './fake.ts';

/**
 * The fake agent answers by the text sent: `wait` asks for input, `slow` works until cancelled, `work` works once and
 * then completes; any other text completes at once. A reply on a task completes it.
 */
function agent({ method, params }: Rpc): unknown {
  if (method === 'CancelTask') return task('CANCELED', { id: params.id });
  if (method === 'GetTask') {
    if (params.id === 'task-slow') return task('WORKING', { id: params.id });
    if (params.id === 'task-wait') return task('INPUT_REQUIRED', { id: params.id });
    return task('COMPLETED', { id: params.id, artifacts: answer('done after work') });
  }
  const message = params.message;
  if (message.taskId) return { task: task('COMPLETED', { id: message.taskId, artifacts: answer(`answered: ${message.parts[0].text}`) }) };
  const text = String(message.parts[0].text);
  if (text === 'wait') return { task: task('INPUT_REQUIRED', { id: 'task-wait' }) };
  if (text === 'slow') return { task: task('WORKING', { id: 'task-slow' }) };
  if (text === 'work') return { task: task('WORKING', { id: 'task-work' }) };
  return { task: task('COMPLETED', { artifacts: answer(`echo: ${text}`) }) };
}

test('a2a-member passes MemberPort conformance against a fake A2A agent', async () => {
  const fake = await startFake(agent);
  try {
    const report = await checkAdapter(adapter, {
      options: { url: fake.cardUrl, pollMs: 10, cancelTimeoutMs: 1000, audience: 'https://billing.example' },
      fixtures: { inputs: ['hello'], wait: 'wait', reply: 'account 42', slow: 'slow', checkpoint: 'work' },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await fake.close();
  }
});
