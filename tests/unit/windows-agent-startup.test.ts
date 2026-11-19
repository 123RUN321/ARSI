import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { windowsCommand } from '../../src/runtime/services/agent-execution/windows-command.js';

test(
  'Windows startup cancellation kills a child created before its first instruction',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-job-startup-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pidFile = join(root, 'child.pid');
    const command = windowsCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      input: '',
    });
    const script = command.args[command.args.indexOf('-File') + 1]!;
    let source = await readFile(
      join(dirname(script), 'windows-job.cs'),
      'utf8',
    );
    const creation = /(      Check\(CreateProcess\([^\n]+\);\n)/;
    assert.match(source, creation);
    // Pause a private copy at the exact former race boundary; production has no test hook.
    source = source.replace(
      creation,
      `$1      System.IO.File.WriteAllText(${JSON.stringify(pidFile)}, child.ProcessId.ToString());\n      Thread.Sleep(Timeout.Infinite);\n`,
    );
    await writeFile(join(root, 'windows-job.cs'), source);
    await copyFile(script, join(root, 'windows-job.ps1'));
    const args = [...command.args];
    args[args.indexOf('-File') + 1] = join(root, 'windows-job.ps1');
    const owner = spawn(command.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let childPid: number | undefined;
    let closed = false;
    const close = new Promise<void>((resolve, reject) => {
      owner.once('error', reject);
      owner.once('close', () => {
        closed = true;
        resolve();
      });
    });
    owner.stdin.end();
    owner.stdout.resume();
    owner.stderr.resume();
    t.after(() => {
      if (!closed) owner.kill();
      if (childPid) {
        try {
          process.kill(childPid);
        } catch {}
      }
    });
    for (let i = 0; i < 500; i++) {
      try {
        childPid = Number(await readFile(pidFile, 'utf8'));
        if (childPid) break;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
      if (closed)
        assert.fail('Job owner exited before reaching process creation');
      await delay(20);
    }
    assert(childPid, 'Child creation barrier was not reached');
    assert.equal(owner.kill('SIGTERM'), true);
    for (let i = 0; i < 250 && !closed; i++) await delay(20);
    assert(
      closed,
      'Inherited pipes remained open after cancelling the job owner',
    );
    await close;
    assert.throws(() => process.kill(childPid!, 0), { code: 'ESRCH' });
  },
);
