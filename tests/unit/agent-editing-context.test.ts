import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { agentFixture } from '../fixtures/agent-execution.js';
import { requestEdit } from '../../src/plugins/shared/agent-editing/index.js';

test('editing hands the actual modified workspace to its business caller without JSON edits replay', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  const prompt = join(f.root, 'prompt.md');
  await writeFile(prompt, 'Edit the candidate directly.');
  const context = f.owner.extend({
    readEvidence: async () => ({}),
    async invokeAgent(_binding, request) {
      assert.equal(request.mode, 'edit');
      const workspace = await f.manager.workspaces.read(request.projectRef);
      assert.match(
        await readFile(join(dirname(workspace.directory), 'AGENTS.md'), 'utf8'),
        /Edit the candidate directly/,
      );
      await writeFile(
        join(workspace.directory, 'result.txt'),
        'actual content',
      );
      return { reason: 'A real file change' };
    },
  });
  const result = await requestEdit(
    { prompt },
    { goal: 'Improve' },
    null,
    context,
  );
  assert.deepEqual(result.result, { reason: 'A real file change' });
  assert.equal(
    await readFile(
      join(
        (await context.workspaces.read(result.editRef)).directory,
        'result.txt',
      ),
      'utf8',
    ),
    'actual content',
  );
});
