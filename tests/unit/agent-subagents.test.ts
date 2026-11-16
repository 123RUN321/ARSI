import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeObservations } from '../../src/plugins/agent-claudecode/observations.js';
import type { AgentObservation } from '../../src/contracts/index.js';

test('native child observations belong to an internal run without fabricated Runtime calls', () => {
  const observations: AgentObservation[] = [];
  const observe = claudeObservations((event) => observations.push(event));
  observe({
    type: 'assistant',
    message: {
      id: 'parent',
      content: [
        { type: 'tool_use', id: 'child-tool', name: 'Agent', input: {} },
      ],
    },
  });
  observe({
    type: 'assistant',
    parent_tool_use_id: 'child-tool',
    message: { id: 'm1', content: [{ type: 'text', text: 'findings' }] },
  });
  assert.deepEqual(observations[1], {
    runId: 'child-tool',
    event: {
      type: 'run.started',
      backend: 'agent.claudecode',
      parentRunId: 'main',
    },
  });
  assert.equal(observations[2]?.runId, 'child-tool');
  assert(!('callId' in observations[1]!));
});
