import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DoctorReport } from '../../src/contracts/index.js';

const execute = promisify(execFile);

test('CLI dashboard requires an existing .rsi directory in its working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cli-dashboard-'));
  const data = join(root, '.rsi');
  try {
    const launch = () =>
      execute(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          resolve('src/entries/cli/main.ts'),
          'dashboard',
        ],
        {
          cwd: root,
          env: { ...process.env, HOME: root, USERPROFILE: root },
          timeout: 5000,
        },
      );
    const checkError = (error: unknown): boolean => {
      assert.ok(error instanceof Error && 'code' in error && 'stderr' in error);
      assert.equal(error.code, 1);
      assert.match(String(error.stderr), /requires a \.rsi directory/);
      return true;
    };
    await assert.rejects(launch(), checkError);
    await assert.rejects(stat(data), { code: 'ENOENT' });

    await writeFile(data, 'preserve me');
    await assert.rejects(launch(), checkError);
    assert.equal(await readFile(data, 'utf8'), 'preserve me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI creates its extension home on first launch and preserves existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cli-home-'));
  const home = join(root, 'home');
  const plugins = join(home, '.arsi', 'plugins');
  const launch = async (...args: string[]): Promise<void> => {
    await execute(
      process.execPath,
      ['--import', 'tsx', resolve('src/entries/cli/main.ts'), ...args],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 30000,
      },
    );
  };
  try {
    await launch();
    assert.ok((await stat(plugins)).isDirectory());
    const marker = join(plugins, 'existing.txt');
    await writeFile(marker, 'preserve me');
    await launch('--help');
    assert.equal(await readFile(marker, 'utf8'), 'preserve me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI reports an error when its home path is occupied by a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cli-home-'));
  const blocked = join(root, '.arsi');
  try {
    await writeFile(blocked, 'preserve me');
    await assert.rejects(
      execute(
        process.execPath,
        ['--import', 'tsx', resolve('src/entries/cli/main.ts'), '--help'],
        {
          env: { ...process.env, HOME: root, USERPROFILE: root },
          timeout: 30000,
        },
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof Error && 'code' in error && 'stderr' in error,
        );
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /ENOTDIR|EEXIST/);
        return true;
      },
    );
    assert.equal(await readFile(blocked, 'utf8'), 'preserve me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI reports runtime cleanup failures and preserves command errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cli-cleanup-'));
  const launch = (...args: string[]) =>
    execute(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/entries/cli/main.ts'),
        '--plugin-dir',
        root,
        ...args,
      ],
      {
        cwd: root,
        env: { ...process.env, HOME: root, USERPROFILE: root },
        timeout: 30000,
      },
    );
  try {
    await writeFile(
      join(root, 'index.mjs'),
      `export function register(registry) {
        registry.retain(registry.catalog().plugins[0]);
        if (process.argv.includes('interrupted')) process.emit('SIGINT');
      }`,
    );
    for (const { args, code } of [
      { args: ['show', 'missing'], code: 1 },
      { args: ['show', 'interrupted'], code: 130 },
      { args: ['catalog'], code: 1 },
    ]) {
      await assert.rejects(launch(...args), (error: unknown) => {
        assert.ok(
          error instanceof Error && 'code' in error && 'stderr' in error,
        );
        assert.equal(error.code, code);
        const diagnostics = String(error.stderr).trimEnd().split(/\r?\n/);
        if (args[0] === 'show')
          assert.match(
            diagnostics.shift() ?? '',
            new RegExp(`ENOENT.*${args[1]}`),
          );
        assert.deepEqual(diagnostics, [
          'Failed to dispose runtime: Runtime plugins are still in use',
        ]);
        return true;
      });
    }
    await assert.rejects(launch('doctor', 'missing.yaml'), (error: unknown) => {
      assert.ok(
        error instanceof Error &&
          'code' in error &&
          'stdout' in error &&
          'stderr' in error,
      );
      assert.equal(error.code, 1);
      assert.equal(error.stderr, '');
      const report: DoctorReport = JSON.parse(String(error.stdout));
      assert.equal(report.summary.failed, 2);
      assert.deepEqual(
        report.checks.map((check) => check.id),
        ['recipe.validate', 'runtime.cleanup'],
      );
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
