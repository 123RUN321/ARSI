import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Evaluator, type CleanupOptions } from 'arsi-evaluator';
import type { JsonObject } from '../../src/contracts/index.js';
import { cleanupExperiment } from '../../src/entries/cli/cleanup.js';
import { runCommand } from '../../src/entries/cli/commands.js';
import { prepareEvaluationConfig } from '../../src/plugins/evaluator-operatorbench/service.js';
import { recordCleanupInput } from '../../src/plugins/shared/evaluator-adapter/cleanup.js';
import { managerFixture } from '../helpers/manager-fixture.js';

for (const ending of ['failed', 'cancelled'] as const) {
  test(`CLI previews and cleans a ${ending} experiment and resumes its checkpoint`, async (t) => {
    const stop = new AbortController();
    let retry = false;
    const calls: string[] = [];
    let configPath = '';
    let logPath = '';
    const f = await managerFixture(
      async (context): Promise<JsonObject> => {
        calls.push(context.callId);
        if (calls.length === 1) {
          configPath = join(context.directory, 'sdk-config.json');
          logPath = join(context.directory, 'worker.log');
          const config = prepareEvaluationConfig(
            { benchmark: 'kernel', environment: 'docker' },
            {
              selected: { id: 'fixture', seed: 1 },
              operation: 'evaluate',
              directory: context.directory,
              manifest: join(context.directory, 'sdk-input', 'manifest.json'),
            },
          );
          await writeFile(configPath, JSON.stringify(config));
          await recordCleanupInput(
            { context, kind: 'kernel' },
            configPath,
            process.env,
          );
          await writeFile(logPath, 'completed first step\n');
          return { score: 1 };
        }
        if (!retry) {
          const error = new Error('fixture interruption');
          if (ending === 'cancelled') stop.abort(error);
          throw error;
        }
        return { done: true };
      },
      {
        policy: {
          steps: [
            { id: 'first', type: 'invoke', use: 'driver', with: {} },
            { id: 'drive', type: 'invoke', use: 'driver', with: {} },
          ],
        },
      },
    );
    t.after(f.dispose);
    const { manager } = f;
    const network = join(manager.rootDirectory, 'network.yaml');
    await writeFile(network, '{}\n');
    const previous = process.env.EVALUATOR_NETWORK_CONFIG;
    process.env.EVALUATOR_NETWORK_CONFIG = network;
    t.after(() => {
      if (previous === undefined) delete process.env.EVALUATOR_NETWORK_CONFIG;
      else process.env.EVALUATOR_NETWORK_CONFIG = previous;
    });
    const recipe = join(manager.rootDirectory, 'recipe.yaml');
    const command = (...args: string[]) =>
      runCommand(args, {
        signal: new AbortController().signal,
        openRuntime: async () => ({
          context: manager.context,
          manager,
          registry: manager.options.registry,
          dispose: f.dispose,
        }),
        releaseRuntime: f.dispose,
      });
    await assert.rejects(
      manager.run(recipe, { id: 'test', signal: stop.signal }),
      /fixture interruption/,
    );
    assert.equal((await manager.get('test')).status, ending);
    const firstCall = calls[0];
    const kind = 'evaluator-cleanup-test';
    const receipt = await manager.facts.read(kind, firstCall);
    assert.deepEqual(receipt.attempts, []);
    const savedState = () =>
      Promise.all([
        manager.get('test'),
        manager.facts.read('checkpoints', 'test'),
        manager.facts.list('checkpoint-entries'),
        manager.facts.list('calls'),
        manager.facts.read('definitions', 'test'),
        manager.facts.read('cleanup', 'test'),
        readFile(configPath),
        readFile(logPath),
      ]);
    const before = await savedState();

    const barrier = new EventEmitter();
    const entered = once(barrier, 'execute');
    const release = once(barrier, 'release');
    let failOnce = true;
    const sdk = t.mock.method(
      Evaluator.prototype,
      'cleanup',
      async (options: CleanupOptions) => {
        assert.equal(options.configPath, configPath);
        if (options.execute) {
          if (failOnce) {
            failOnce = false;
            throw new Error('fixture daemon unavailable');
          }
          barrier.emit('execute');
          await release;
        }
        return {
          preview: !options.execute,
          nodes: [
            {
              nodeId: 'local',
              daemonId: 'fixture',
              items: [
                {
                  reference: 'fixture/owned:1',
                  imageId: 'fixture-id',
                  status: options.execute ? 'deleted' : 'candidate',
                  reason: 'owned by the fixture',
                },
              ],
            },
          ],
        };
      },
    );
    const inspected = await command('cleanup', 'test', '--dry-run');
    assert.equal(inspected.exitCode, 0);
    const plan = JSON.parse(inspected.stdout!);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.results[0].status, 'preview');
    assert.deepEqual(plan.results[0].report.nodes[0].items[0], {
      reference: 'fixture/owned:1',
      imageId: 'fixture-id',
      status: 'candidate',
      reason: 'owned by the fixture',
    });
    assert.deepEqual(await manager.facts.read(kind, firstCall), receipt);
    assert.deepEqual(await savedState(), before);
    const partial = await command('cleanup', 'test');
    assert.equal(partial.exitCode, 1);
    const pending = JSON.parse(partial.stdout!).results[0];
    assert.equal(pending.status, 'pending');
    assert.match(pending.error, /fixture daemon unavailable/);
    assert.equal((await manager.facts.read(kind, firstCall)).status, 'pending');
    const execution = command('cleanup', 'test');
    try {
      await Promise.race([
        entered,
        execution.then(() =>
          assert.fail('cleanup did not execute the receipt'),
        ),
      ]);
      await assert.rejects(command('cleanup', 'test'), /in use/);
      await assert.rejects(
        command('run', recipe, '--id', 'test', '--resume'),
        /lock/i,
      );
      assert.equal((await command('cleanup', 'test', '--dry-run')).exitCode, 0);
    } finally {
      barrier.emit('release');
    }
    const cleaned = await execution;
    assert.equal(cleaned.exitCode, 0);
    const result = JSON.parse(cleaned.stdout!).results[0];
    assert.equal(result.status, 'complete');
    assert.equal(result.report.nodes[0].items[0].status, 'deleted');
    assert.equal(
      (await manager.facts.read(kind, firstCall)).status,
      'complete',
    );
    assert.deepEqual(await savedState(), before);
    const repeated = await command('cleanup', 'test');
    assert.deepEqual(JSON.parse(repeated.stdout!).results, []);
    assert.deepEqual(
      sdk.mock.calls.map((call) => call.arguments[0].execute),
      [false, true, true, false],
    );

    retry = true;
    const resumed = await command('run', recipe, '--id', 'test', '--resume');
    const experiment = JSON.parse(resumed.stdout!);
    assert.equal(experiment.id, 'test');
    assert.equal(experiment.status, 'succeeded');
    assert.deepEqual(experiment.output, { done: true });
    assert.equal(calls.length, 3);
    assert.equal(calls.filter((id) => id === firstCall).length, 1);
  });
}

test('an active experiment can be previewed while execution stays with its owner', async (t) => {
  const barrier = new EventEmitter();
  const entered = once(barrier, 'running');
  const release = once(barrier, 'release');
  const f = await managerFixture(async () => {
    barrier.emit('running');
    await release;
    return { done: true };
  });
  t.after(f.dispose);
  const signal = new AbortController().signal;
  const running = f.run();
  try {
    await Promise.race([
      entered,
      running.then(() => assert.fail('experiment already ended')),
    ]);
    assert.deepEqual(await cleanupExperiment(f.manager, 'test', true, signal), {
      experimentId: 'test',
      dryRun: true,
      results: [],
    });
    await assert.rejects(
      cleanupExperiment(f.manager, 'test', false, signal),
      /in use/,
    );
    assert.equal((await f.manager.get('test')).status, 'running');
  } finally {
    barrier.emit('release');
    await running;
  }
});
