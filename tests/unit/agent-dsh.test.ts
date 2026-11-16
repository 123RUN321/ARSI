import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentDsh } from '../../src/plugins/agent-dsh/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('DSH consumes committed text, thinking, tools, truncation and its native final result', async (t) => {
  const f = await agentFixture(async (spec, consume) => {
    assert(!spec.args.includes('--permission-mode'));
    for (const event of [
      { type: 'session', sessionId: 's1' },
      { type: 'thinking', text: 'Visible reasoning' },
      { type: 'text', text: 'Working', truncated: true },
      {
        type: 'tool_call',
        callId: 't1',
        tool: 'Read',
        input: { path: 'candidate/input.txt' },
      },
      {
        type: 'tool_result',
        callId: 't1',
        result: 'original',
        status: 'completed',
      },
      {
        type: 'final',
        sessionId: 's1',
        reason: { kind: 'completed' },
        text: '{"answer":"ok"}',
      },
    ])
      await consume(JSON.stringify(event), () => {});
  });
  t.after(() => f.close());
  const agent = await createAgentDsh(
    { executable: process.execPath },
    f.context,
  );
  assert.deepEqual(await f.execute(agent), { answer: 'ok' });
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert(records.items.some((r) => r.event?.type === 'observation.gap'));
  assert(records.items.some((r) => r.event?.type === 'tool.completed'));
});
