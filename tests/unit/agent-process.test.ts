import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentProcessLauncher } from '../../src/runtime/services/agent-execution/process.js';
import { windowsCommand } from '../../src/runtime/services/agent-execution/windows-command.js';

test('Windows job launch transports literal argv and ships its lifecycle owner', async () => {
  const spec = {
    executable: 'C:\\Agent Tools\\node.exe',
    args: ['a"b', '$(literal)', '尾部\\', ''],
    input: '',
  };
  const command = windowsCommand(spec);
  assert.equal(
    command.args[command.args.indexOf('-File') + 1]?.endsWith(
      'windows-job.ps1',
    ),
    true,
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(command.args.at(-1)!, 'base64').toString()),
    { executable: spec.executable, args: spec.args },
  );
  await access(
    new URL(
      '../../src/runtime/services/agent-execution/windows-job.cs',
      import.meta.url,
    ),
  );
});

test(
  'cleanup uncertainty takes precedence over a preceding protocol failure',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'rsi-process-failure-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const original = process.kill;
    const cleanupError = Object.assign(
      new Error('Synthetic permission failure'),
      { code: 'EPERM' },
    );
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && signal === 'SIGTERM') throw cleanupError;
      return original(pid, signal);
    }) as typeof process.kill;
    t.after(() => {
      process.kill = original;
    });
    const launch = agentProcessLauncher({
      project: directory,
      signal: new AbortController().signal,
    });
    await assert.rejects(
      launch(
        {
          executable: process.execPath,
          args: ['-e', 'console.log("ready");setInterval(()=>{},1000)'],
          input: '',
        },
        () => {
          throw new Error('Invalid protocol');
        },
      ),
      (error: Error) => {
        assert.ok(
          error instanceof Error &&
            'status' in error &&
            error.status === 'unknown',
        );
        return true;
      },
    );
  },
);
