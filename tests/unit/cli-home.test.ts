import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
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

test('CLI leaves the extension home untouched and shows help even if its path is blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cli-home-'));
  const home = join(root, '.arsi');
  const launch = (...args: string[]) =>
    execute(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/entries/cli/main.ts'),
        ...args,
      ],
      {
        cwd: root,
        env: { ...process.env, HOME: root, USERPROFILE: root },
        timeout: 30000,
      },
    );
  try {
    const { stdout } = await launch('catalog');
    assert.match(stdout, /"application\.agentbundle"/);
    await assert.rejects(stat(home), { code: 'ENOENT' });

    await writeFile(home, 'preserve me');
    const help = await launch('--help');
    assert.match(help.stdout, /Usage: arsi/);
    assert.equal(help.stderr, '');
    assert.equal(await readFile(home, 'utf8'), 'preserve me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'CLI handles the first SIGINT and forces exit on the second during stalled registration',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-cli-signal-'));
    try {
      await writeFile(
        join(root, 'index.mjs'),
        `export async function register() {
          process.once('SIGINT', () => process.send('interrupted'));
          process.send('registering');
          await new Promise(() => setInterval(() => {}, 1000));
        }`,
      );
      const child = fork(
        resolve('src/entries/cli/main.ts'),
        ['catalog', '--plugin-dir', root],
        {
          execArgv: ['--import', import.meta.resolve('tsx')],
          cwd: root,
          env: { ...process.env, HOME: root, USERPROFILE: root },
        },
      );
      const closed = once(child, 'close');
      try {
        const [phase] = await once(child, 'message', {
          signal: AbortSignal.timeout(30000),
        });
        assert.equal(phase, 'registering');
        const interrupted = once(child, 'message', {
          signal: AbortSignal.timeout(5000),
        });
        assert.ok(child.kill('SIGINT'));
        const [message] = await interrupted;
        assert.equal(message, 'interrupted');

        const exited = once(child, 'exit', {
          signal: AbortSignal.timeout(5000),
        });
        assert.ok(child.kill('SIGINT'));
        assert.deepEqual(await exited, [130, null]);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await closed;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
        if (process.argv.includes('interrupted-during-cleanup')) {
          const dispose = registry.dispose.bind(registry);
          registry.dispose = () => {
            process.emit('SIGINT');
            return dispose();
          };
        }
      }`,
    );
    for (const { args, code, commandError } of [
      { args: ['show', 'missing'], code: 1, commandError: /ENOENT.*missing/ },
      {
        args: ['show', 'interrupted'],
        code: 130,
        commandError: /ENOENT.*interrupted/,
      },
      {
        args: ['doctor', 'interrupted'],
        code: 130,
        commandError: /^Interrupted$/,
      },
      {
        args: ['doctor', 'interrupted-during-cleanup'],
        code: 130,
        commandError: /^Interrupted$/,
      },
      { args: ['catalog'], code: 1 },
    ]) {
      await assert.rejects(launch(...args), (error: unknown) => {
        assert.ok(
          error instanceof Error &&
            'code' in error &&
            'stdout' in error &&
            'stderr' in error,
        );
        assert.equal(error.code, code);
        if (args[0] === 'doctor') assert.equal(error.stdout, '');
        const diagnostics = String(error.stderr).trimEnd().split(/\r?\n/);
        if (commandError) assert.match(diagnostics.shift() ?? '', commandError);
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
      assert.equal(
        report.checks.filter(({ status }) => status === 'failed').length,
        2,
      );
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
