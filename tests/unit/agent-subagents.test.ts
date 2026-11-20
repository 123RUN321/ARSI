import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeObservations } from '../../src/plugins/agent-claudecode/observations.js';
import type { AgentObservation } from '../../src/contracts/index.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectSubagentTool } from '../../src/plugins/agent-pi/subagent.js';

test('Pi delegates the tool cancellation signal and rejects a late child result', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-child-cancel-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'roles'));
  await writeFile(join(cwd, 'roles/scout.md'), 'Inspect evidence.');
  const controller = new AbortController();
  const reason = new Error('Child tool cancelled');
  let invoked = 0;
  const tool = await createProjectSubagentTool(
    cwd,
    async (role, task, signal) => {
      invoked++;
      assert.equal(role, 'scout');
      assert.equal(task, 'Inspect');
      assert.equal(signal, controller.signal);
      controller.abort(reason);
      return { findings: 'late result' };
    },
  );
  assert(tool);
  const input = { agent: 'scout', task: 'Inspect' };
  await assert.rejects(
    Reflect.apply(tool.execute, tool, ['child', input, controller.signal]),
    reason,
  );
  assert.equal(invoked, 1);
  await assert.rejects(
    Reflect.apply(tool.execute, tool, ['child2', input, controller.signal]),
    reason,
  );
  assert.equal(invoked, 1);
});

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
