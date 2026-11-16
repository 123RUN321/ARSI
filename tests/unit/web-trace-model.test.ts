import test from 'node:test';
import assert from 'node:assert/strict';
import { traceRows } from '../../web/features/experiments/trace-model.js';
import type { AgentEvent } from '../../src/contracts/index.js';
import type { CallTrace } from '../../src/contracts/observation.js';
function event(
  sequence: number,
  value: AgentEvent,
  runId = 'main',
): CallTrace['items'][number] {
  return {
    sequence,
    at: null,
    type: value.type,
    runId,
    event: value,
    native: null,
    payloadRef: null,
  };
}
test('parallel tools pair by run and ID, and final messages replace their deltas', () => {
  const rows = traceRows([
    event(1, {
      type: 'tool.started',
      toolCallId: 'a',
      name: 'Read',
      input: { path: 'a' },
    }),
    event(2, {
      type: 'tool.started',
      toolCallId: 'b',
      name: 'Read',
      input: { path: 'b' },
    }),
    event(3, {
      type: 'tool.completed',
      toolCallId: 'b',
      output: 'B',
      status: 'succeeded',
    }),
    event(4, {
      type: 'tool.completed',
      toolCallId: 'a',
      output: 'A',
      status: 'failed',
    }),
    event(5, { type: 'message.appended', messageId: 'm', text: 'hel' }),
    event(6, { type: 'message.appended', messageId: 'm', text: 'lo' }),
    event(7, {
      type: 'message.completed',
      messageId: 'm',
      role: 'assistant',
      text: 'hello',
    }),
    event(
      8,
      {
        type: 'tool.completed',
        toolCallId: 'a',
        output: 'child',
        status: 'succeeded',
      },
      'child',
    ),
  ]);
  assert.equal(rows[0].result, 'A');
  assert.equal(rows[0].status, 'Failed');
  assert.equal(rows[1].result, 'B');
  assert.equal(rows[2].body, 'hello');
  assert.equal(rows[3].result, 'child');
  assert.equal(rows.length, 4);
});
