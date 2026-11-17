import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixture } from '../fixtures/agent-execution.js';
import { createAgentCodex } from '../../src/plugins/agent-codex/service.js';
import { createAgentClaudeCode } from '../../src/plugins/agent-claudecode/service.js';
import { createAgentDsh } from '../../src/plugins/agent-dsh/service.js';
import { createAgentOpenCode } from '../../src/plugins/agent-opencode/service.js';

for (const [name, create] of [
  ['Codex', createAgentCodex],
  ['Claude Code', createAgentClaudeCode],
  ['DSH', createAgentDsh],
  ['OpenCode', createAgentOpenCode],
] as const) {
  test(`${name} rejects unsupported role dispatch before launching its native CLI`, async (t) => {
    const f = await agentFixture(async () => assert.fail('must not launch'));
    t.after(() => f.close());
    const agent = await create({ executable: process.execPath }, f.context);
    await assert.rejects(
      f.execute(agent, { ...f.request, role: 'scout' }),
      /native.*(delegation|subagents|Agent|spawn_agent)|native/i,
    );
  });
}
