import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCodex } from '../../src/plugins/agent-codex/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('Codex drives app-server, records commentary and tools, and validates the terminal answer', async (t) => {
  const sent: unknown[] = [];
  const f = await agentFixture(async (spec, consume) => {
    assert(spec.interactive);
    const send = (message: unknown) => sent.push(message);
    for (const message of [
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: 'thread1' }, model: 'test' } },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: {
            id: 'comment',
            type: 'agentMessage',
            phase: 'commentary',
            text: 'Reading',
          },
        },
      },
      {
        method: 'item/started',
        params: {
          threadId: 'thread1',
          item: {
            id: 'tool1',
            type: 'commandExecution',
            command: 'cat candidate/input.txt',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: {
            id: 'tool1',
            type: 'commandExecution',
            status: 'completed',
            aggregatedOutput: 'original',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: { id: 'answer', type: 'agentMessage', text: '{"answer":"ok"}' },
        },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread1', turn: { status: 'completed' } },
      },
    ])
      await consume(JSON.stringify(message), send);
  });
  t.after(() => f.close());
  const agent = await createAgentCodex(
    { executable: process.execPath },
    f.context,
  );
  assert.deepEqual(await f.execute(agent), { answer: 'ok' });
  assert.equal(sent.length, 3);
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert(
    records.items.some(
      (r) =>
        r.event?.type === 'message.completed' && r.event.phase === 'commentary',
    ),
  );
  assert(records.items.some((r) => r.event?.type === 'tool.completed'));
});

test('native agents reject an unenforceable modelCalls budget before launch', async (t) => {
  const f = await agentFixture(async () => {
    assert.fail('must not launch');
  });
  t.after(() => f.close());
  const agent = await createAgentCodex(
    { executable: process.execPath },
    f.context,
  );
  await assert.rejects(
    f.execute(
      agent,
      f.request,
      f.context.extend({
        scope: {
          id: 'test',
          signal: f.context.signal,
          limits: { modelCalls: 1 },
        },
      }),
    ),
    /cannot enforce/,
  );
});
