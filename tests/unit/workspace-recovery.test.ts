import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileArtifacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';

test('workspace restoration uses immutable bytes at the original identity and refuses conflicting or partial data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-workspace-recovery-'));
  try {
    const artifacts = new FileArtifacts(join(root, 'artifacts'));
    const directory = join(root, 'workspaces');
    const workspaces = new FileWorkspaces(directory, artifacts);
    await mkdir(join(root, 'input'));
    await writeFile(join(root, 'input/skill.txt'), 'original');
    const artifact = await artifacts.capture(join(root, 'input'));
    const original = await workspaces.create(artifact);
    await workspaces.release(original.ref);
    const restored = await workspaces.restore(original.ref, artifact);
    assert.equal(restored.directory, original.directory);
    assert.equal(
      await readFile(join(restored.directory, 'skill.txt'), 'utf8'),
      'original',
    );
    assert.deepEqual(
      await workspaces.restore(original.ref, artifact),
      restored,
    );
    await writeFile(join(restored.directory, 'skill.txt'), 'changed');
    await assert.rejects(workspaces.restore(original.ref, artifact), /differs/);
    assert.equal(
      await readFile(join(restored.directory, 'skill.txt'), 'utf8'),
      'changed',
    );
    await mkdir(join(directory, 'partial'));
    await writeFile(join(directory, 'partial/evidence'), 'keep');
    await assert.rejects(workspaces.restore('partial', artifact));
    assert.equal(
      await readFile(join(directory, 'partial/evidence'), 'utf8'),
      'keep',
    );
    await assert.rejects(workspaces.restore('../escape', artifact));
    assert.deepEqual(
      (await readdir(directory)).sort(),
      [original.ref, 'partial'].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
