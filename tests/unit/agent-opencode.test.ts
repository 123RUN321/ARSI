import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentOpenCode } from '../../src/plugins/agent-opencode/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('OpenCode records its V2 parts and returns only the stopped final message', async (t) => {
  const f = await agentFixture(async (_spec, consume) => {
    for (const event of [
      {
        type: 'tool_use',
        sessionID: 's1',
        part: {
          id: 'p1',
          callID: 't1',
          tool: 'read',
          state: {
            status: 'completed',
            input: { path: 'candidate/input.txt' },
            output: 'original',
          },
        },
      },
      {
        type: 'text',
        sessionID: 's1',
        part: { id: 'text1', messageID: 'm1', text: '{"answer":"ok"}' },
      },
      {
        type: 'step_finish',
        sessionID: 's1',
        part: {
          id: 'finish1',
          messageID: 'm1',
          reason: 'stop',
          tokens: { input: 10, output: 5 },
        },
      },
    ])
      await consume(JSON.stringify(event), () => {});
  });
  t.after(() => f.close());
  const agent = await createAgentOpenCode(
    { executable: process.execPath },
    f.context,
  );
  assert.deepEqual(await agent.execute(f.request, f.context), { answer: 'ok' });
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert(records.items.some((r) => r.event?.type === 'tool.completed'));
  await assert.rejects(
    agent.execute(
      { ...f.request, requirements: { delegation: true } },
      f.context,
    ),
    /does not support native delegation/,
  );
});
