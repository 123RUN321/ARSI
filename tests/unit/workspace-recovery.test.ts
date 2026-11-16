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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

test(
  'Windows workspace restore waits for a temporary file sharing lock without changing identity',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-workspace-lock-'));
    let holder: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown> | undefined;
    try {
      const artifacts = new FileArtifacts(join(root, 'artifacts'));
      await mkdir(join(root, 'input'));
      await writeFile(join(root, 'input/skill.txt'), 'immutable');
      const artifact = await artifacts.capture(join(root, 'input'));
      const script = join(root, 'hold.ps1');
      await writeFile(
        script,
        `param([string]$Path)
$handle = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::WriteLine('locked')
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 200
} finally { $handle.Dispose() }
`,
      );
      class SharingLockedWorkspaces extends FileWorkspaces {
        override async create(ref?: string, parent?: string) {
          const workspace = await super.create(ref, parent);
          holder = spawn(
            join(
              process.env.SystemRoot ?? 'C:\\Windows',
              'System32/WindowsPowerShell/v1.0/powershell.exe',
            ),
            [
              '-NoProfile',
              '-NonInteractive',
              '-File',
              script,
              '-Path',
              join(workspace.directory, 'skill.txt'),
            ],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          exited = once(holder, 'close');
          const [ready] = await once(holder.stdout!, 'data');
          assert.match(String(ready), /locked/);
          return workspace;
        }
      }
      const workspaces = new SharingLockedWorkspaces(
        join(root, 'workspaces'),
        artifacts,
      );
      const workspace = await workspaces.restore('original-identity', artifact);
      assert.equal(workspace.ref, 'original-identity');
      assert.equal(await artifacts.capture(workspace.directory), artifact);
      await exited;
    } finally {
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);
