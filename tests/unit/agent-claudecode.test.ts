import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClaudeCode } from '../../src/plugins/agent-claudecode/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('Claude translates text, thinking and correlated tool results while returning structured output', async (t) => {
  const f = await agentFixture(async (spec, consume) => {
    assert(spec.args.includes('stream-json'));
    assert(spec.args.includes('--forward-subagent-text'));
    for (const message of [
      { type: 'assistant', message: null },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'thinking', thinking: 'visible' },
            { type: 'text', text: 'Working' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { path: 'candidate/input.txt' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'original' },
          ],
        },
      },
      {
        type: 'result',
        is_error: false,
        subtype: 'success',
        structured_output: { answer: 'ok' },
        usage: { input_tokens: 10 },
      },
    ])
      await consume(JSON.stringify(message), () => {});
  });
  t.after(() => f.close());
  const agent = await createAgentClaudeCode(
    { executable: process.execPath },
    f.context,
  );
  assert.deepEqual(await f.execute(agent), { answer: 'ok' });
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert(
    records.items.some(
      (item) =>
        item.event?.type === 'observation.gap' &&
        item.event.reason.includes('object'),
    ),
  );
  assert(
    records.items.some(
      (r) => r.event?.type === 'tool.completed' && r.event.toolCallId === 't1',
    ),
  );
  assert(
    records.items.some(
      (r) =>
        r.event?.type === 'message.completed' && r.event.thinking === 'visible',
    ),
  );
});

test('Claude rejects invalid final output without correction or a second launch', async (t) => {
  let launches = 0;
  const f = await agentFixture(async (_spec, consume) => {
    launches++;
    await consume(
      JSON.stringify({
        type: 'result',
        is_error: false,
        subtype: 'success',
        structured_output: { wrong: true },
      }),
      () => {},
    );
  });
  t.after(() => f.close());
  const agent = await createAgentClaudeCode(
    { executable: process.execPath },
    f.context,
  );
  await assert.rejects(f.execute(agent), /agent output|Agent output/);
  assert.equal(launches, 1);
});
