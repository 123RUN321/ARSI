import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { agentFixture } from '../fixtures/agent-execution.js';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';

test('projects are independent references with one editable workspace and an immutable input snapshot', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  const secondRef = await prepareAgentProject(
    f.owner,
    'Independent task',
    { 'candidate/input.txt': 'original' },
    [],
    [],
  );
  assert.notEqual(secondRef, f.request.projectRef);
  const first = await f.manager.workspaces.read(f.request.projectRef);
  const second = await f.manager.workspaces.read(secondRef);
  await writeFile(join(first.directory, 'input.txt'), 'edited');
  assert.equal(
    await readFile(join(second.directory, 'input.txt'), 'utf8'),
    'original',
  );
  assert.equal(dirname(first.directory), f.directory);
  assert.equal(first.project?.ownerCallId, 'owner');
  const snapshot = await f.manager.artifacts.readJson(first.project!.inputRef);
  assert(
    JSON.stringify(snapshot).includes(
      Buffer.from('original').toString('base64'),
    ),
  );
});
