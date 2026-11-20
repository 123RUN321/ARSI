import test from 'node:test';
import assert from 'node:assert/strict';
import { traceRows } from '../../web/features/experiments/trace-model.js';
import type { AgentEvent } from '../../src/contracts/index.js';
import type { CallTrace } from '../../src/contracts/observation.js';
function event(
  sequence: number,
  value: AgentEvent,
  runId = 'main',
  at: string | null = null,
): CallTrace['items'][number] {
  return {
    sequence,
    at,
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

test('tool durations use matching run timestamps and leave missing starts unknown', () => {
  const rows = traceRows([
    event(
      1,
      { type: 'tool.started', toolCallId: 'a', name: 'Read', input: {} },
      'main',
      '2026-11-17T00:00:00.000Z',
    ),
    event(
      2,
      { type: 'tool.started', toolCallId: 'a', name: 'Read', input: {} },
      'child',
      '2026-11-17T00:00:01.000Z',
    ),
    event(
      3,
      {
        type: 'tool.completed',
        toolCallId: 'a',
        output: '',
        status: 'succeeded',
      },
      'main',
      '2026-11-17T00:00:02.500Z',
    ),
    event(
      4,
      {
        type: 'tool.completed',
        toolCallId: 'a',
        output: '',
        status: 'succeeded',
      },
      'child',
      '2026-11-17T00:00:04.000Z',
    ),
    event(
      5,
      {
        type: 'tool.completed',
        toolCallId: 'orphan',
        output: '',
        status: 'succeeded',
      },
      'main',
      '2026-11-17T00:00:05.000Z',
    ),
  ]);
  assert.deepEqual(
    rows.map((row) => row.duration),
    [2.5, 3, null],
  );
});

test('lazy tool bodies retain pairing, completion status and both payload references', () => {
  const start = event(1, {
    type: 'tool.started',
    toolCallId: 't',
    name: 'Read',
    input: null,
  });
  const end = event(2, {
    type: 'tool.completed',
    toolCallId: 't',
    output: null,
    status: 'succeeded',
    durationMs: 2500,
  });
  start.payloadRef = 'input-ref';
  end.payloadRef = 'output-ref';
  const rows = traceRows([start, end]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'tool');
  assert.equal(rows[0].status, 'Succeeded');
  assert.equal(rows[0].duration, 2.5);
  assert.deepEqual(rows[0].payloadRefs, ['input-ref', 'output-ref']);
});
