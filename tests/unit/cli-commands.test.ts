import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CommandUsageError,
  runCommand,
} from '../../src/entries/cli/commands.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';

const home = await mkdtemp(join(tmpdir(), 'rsi-cli-commands-'));
const homeVariable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
const previousHome = process.env[homeVariable];
process.env[homeVariable] = home;
after(async () => {
  if (previousHome === undefined) delete process.env[homeVariable];
  else process.env[homeVariable] = previousHome;
  await rm(home, { recursive: true, force: true });
});

const withoutRuntime = {
  signal: new AbortController().signal,
  async openRuntime(): Promise<never> {
    assert.fail('The CLI opened a Runtime');
  },
  async disposeRuntime(): Promise<never> {
    assert.fail('The CLI disposed a Runtime');
  },
};

function commandFixture(t: TestContext) {
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: home });
  const disposeRuntime = async (): Promise<void> => {
    await manager.dispose();
    await registry.dispose();
  };
  const openRuntime = t.mock.fn(async (_pluginDirectories: string[]) => ({
    manager,
    registry,
    context: manager.context,
    dispose: disposeRuntime,
  }));
  t.after(disposeRuntime);
  return {
    manager,
    openRuntime,
    context: { ...withoutRuntime, openRuntime },
  };
}

test('CLI forwards run options and repeatable global plugin directories', async (t) => {
  const { manager, openRuntime, context } = commandFixture(t);
  const run = t.mock.method(manager, 'run', async () => ({ status: 'ok' }));

  const result = await runCommand(
    [
      '--plugin-dir',
      'a',
      'run',
      'recipe.yaml',
      '--id=experiment',
      '--resume',
      '--plugin-dir',
      'b',
    ],
    context,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout ?? ''), { status: 'ok' });
  assert.deepEqual(openRuntime.mock.calls[0].arguments, [['a', 'b']]);
  assert.deepEqual(run.mock.calls[0].arguments, [
    resolve('recipe.yaml'),
    { id: 'experiment', resume: true, signal: context.signal },
  ]);

  await runCommand(['run', 'recipe.yaml'], context);
  assert.deepEqual(run.mock.calls[1].arguments, [
    resolve('recipe.yaml'),
    { id: undefined, resume: false, signal: context.signal },
  ]);
});

test('CLI provides command-specific and nested help', async () => {
  for (const args of [
    [],
    ['-h'],
    ['run', '-h'],
    ['doctor', '--help'],
    ['reflection', '-h'],
    ['reflection', 'apply', '-h'],
    ['run', '--help'],
    ['help', 'run'],
    ['reflection', 'apply', '--help'],
  ]) {
    const result = await runCommand(args, withoutRuntime);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout ?? '', /Usage:/);
    if (args.includes('run')) assert.match(result.stdout ?? '', /--resume/);
    if (args.includes('doctor')) assert.match(result.stdout ?? '', /--static/);
    if (args.includes('apply')) assert.match(result.stdout ?? '', /revisionID/);
  }
});

test('CLI rejects invalid input before runtime initialization', async () => {
  for (const args of [
    ['run'],
    ['run', 'r', '--resume'],
    ['run', 'recipe.yaml', '--id', 'run', '--retry'],
    ['show', 'id', 'extra'],
    ['catalog', '--bad'],
    ['list', 'bad'],
    ['reflection', 'apply'],
    ['dashboard', '--port', '0'],
    ['dashboard', '--port', '65536'],
    ['--plugin-dir'],
    ['serve'],
    ['unknown'],
    ['validate', 'r.yaml'],
  ]) {
    await assert.rejects(runCommand(args, withoutRuntime), CommandUsageError);
  }
  await assert.rejects(
    runCommand(['run', 'r', '--resume'], withoutRuntime),
    /requires --id/,
  );
  await assert.rejects(
    runCommand(['run', 'r', '--retry'], withoutRuntime),
    /unknown option/,
  );
});

test('CLI dispatches experiment actions and nested reflection actions', async (t) => {
  const { manager, context } = commandFixture(t);
  const cancel = t.mock.method(manager, 'cancel', async () => {});
  t.mock.method(manager, 'get', async (id: string) => ({ experiment: id }));
  t.mock.method(manager, 'list', async () => [{ experiment: 'exp' }]);
  const revisions = manager.reflection();
  t.mock.method(manager, 'reflection', () => revisions);
  t.mock.method(revisions, 'list', async (id?: string) => [
    { id: id ?? 'all' },
  ]);
  t.mock.method(revisions, 'show', async (id: string) => ({ shown: id }));
  t.mock.method(revisions, 'apply', async (id: string) => ({ applied: id }));

  const run = async (...args: string[]): Promise<unknown> => {
    const result = await runCommand(args, context);
    assert.equal(result.exitCode, 0);
    return JSON.parse(result.stdout ?? '');
  };
  assert.deepEqual(await run('list'), [{ experiment: 'exp' }]);
  assert.deepEqual(await run('show', 'exp'), { experiment: 'exp' });
  assert.deepEqual(await run('cancel', 'exp'), {
    id: 'exp',
    cancellationRequested: true,
  });
  assert.deepEqual(cancel.mock.calls[0].arguments, ['exp']);
  assert.deepEqual(await run('reflection', 'list'), [{ id: 'all' }]);
  assert.deepEqual(await run('reflection', 'list', ''), [{ id: 'all' }]);
  assert.deepEqual(await run('reflection', 'list', 'exp'), [{ id: 'exp' }]);
  assert.deepEqual(await run('reflection', 'show', 'rev'), { shown: 'rev' });
  assert.deepEqual(await run('reflection', 'apply', 'rev'), { applied: 'rev' });
  await assert.rejects(
    run('reflection', 'apply', ''),
    /Revision ID is required/,
  );
});

test('CLI usage errors include focused help like evaluator', async () => {
  for (const args of [
    ['run'],
    ['run', 'r.yaml', '--resume'],
    ['dashboard', '--port', '0'],
  ]) {
    await assert.rejects(runCommand(args, withoutRuntime), (error: unknown) => {
      assert.ok(error instanceof CommandUsageError);
      assert.match(error.helpText, new RegExp('Usage: arsi ' + args[0]));
      return true;
    });
  }
});
