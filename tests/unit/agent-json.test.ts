import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentBackend,
  nativeCapabilities,
} from '../../src/plugins/shared/agent-backend/runner.js';
import { agentFixture } from '../fixtures/agent-execution.js';

test('final JSON is validated once and never salvaged or corrected', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  let runs = 0;
  const agent = agentBackend({
    id: 'test',
    capabilities: nativeCapabilities(false),
    async run() {
      runs++;
      return { wrong: true };
    },
  });
  await assert.rejects(agent.execute(f.request, f.context), /Agent output/);
  assert.equal(runs, 1);
});
