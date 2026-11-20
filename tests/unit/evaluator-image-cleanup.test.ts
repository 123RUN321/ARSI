import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import childProcess, { type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { FileFacts } from '../../src/runtime/storage/index.js';
import { object } from '../../src/shared/json.js';
import {
  cleanupEvaluatorImages,
  recordImageCleanupInput,
} from '../../src/plugins/shared/evaluator-adapter/image-cleanup.js';
import { prepareEvaluationConfig } from '../../src/plugins/evaluator-agentbench/service.js';
import { prepareEvaluationConfig as prepareKernelConfig } from '../../src/plugins/evaluator-operatorbench/service.js';
import { runSdkCli } from '../../src/plugins/shared/evaluator-adapter/cli.js';

async function fixture(t: test.TestContext) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'rsi-image-cleanup-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const network = join(dataDirectory, 'network.yaml');
  await writeFile(network, '{}\n');
  for (const [key, value] of Object.entries({
    EVALUATOR_NETWORK_CONFIG: network,
    EVALUATOR_CACHE_DIR: join(dataDirectory, 'cache'),
    DOCKER_HOST: 'tcp://127.0.0.1:1',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const facts = new FileFacts(join(dataDirectory, 'facts'));
  const experimentId = 'images';
  const kind = 'evaluator-images-images';
  await facts.write('definitions', experimentId, {
    recipe: { application: { plugin: 'application.agentbundle' } },
  });
  const context = new RuntimeContext().extend({
    experimentId,
    dataDirectory,
    facts,
    signal: new AbortController().signal,
  });
  const callId = 'call-' + 'a'.repeat(32);
  async function register(
    attempt?: string,
    workspaceRef: string | null = randomUUID(),
    overrides: JsonObject = {},
  ) {
    const directory = join(
      dataDirectory,
      'experiments',
      experimentId,
      'calls',
      callId,
      ...(attempt ? ['attempts', attempt] : []),
    );
    const idempotencyKey = attempt ? callId + '-' + attempt : callId;
    const call = context.extend({ directory, callId, idempotencyKey });
    const input = prepareEvaluationConfig(
      {
        benchmark: { name: 'terminalbench', version: '4.0' },
        services: {
          default: {
            model: 'fixture',
            base_url: 'http://localhost:1',
            api_key: '${UNSET_FIXTURE_TOKEN}',
          },
        },
        environment: 'docker',
        ...overrides,
      },
      {
        directory,
        taskIds: ['fixture-task'],
        execution: {
          directory: workspaceRef
            ? join(dataDirectory, 'workspaces', workspaceRef, 'files')
            : dataDirectory,
        },
      },
    );
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'evaluator.json');
    await writeFile(path, JSON.stringify(input));
    await recordImageCleanupInput(
      { context: call, kind: 'agentbundle', workspaceRef },
      path,
      process.env,
    );
    return { key: idempotencyKey, path };
  }
  return {
    context,
    kind,
    register,
    read: (key: string) => facts.read(kind, key),
  };
}

function report(...statuses: string[]): JsonObject {
  return {
    preview: false,
    nodes: [
      {
        nodeId: 'fixture',
        daemonId: 'fixture',
        items: statuses.map((status) => ({
          reference: 'fixture/' + status,
          imageId: 'fixture-id',
          status,
          reason: 'fixture ' + status,
        })),
      },
    ],
  };
}

test('cleanup preserves per-attempt SDK outcomes and only retries pending inputs', async (t) => {
  const f = await fixture(t);
  const first = await f.register();
  const second = await f.register('b'.repeat(24));
  const paths: string[] = [];
  const partial = report(
    'deleted',
    'retained',
    'skipped',
    'failed',
    'candidate',
  );
  await cleanupEvaluatorImages(f.context, async (options) => {
    assert.equal(options.command, 'cleanup images');
    paths.push(options.configPath);
    return options.configPath === first.path ? partial : report('retained');
  });
  assert.deepEqual(paths.sort(), [first.path, second.path].sort());
  assert.equal((await f.read(second.key)).status, 'complete');
  const pending = await f.read(first.key);
  assert.equal(pending.status, 'pending');
  assert.ok(Array.isArray(pending.attempts));
  assert.deepEqual(object(pending.attempts[0]).report, partial);
  await cleanupEvaluatorImages(f.context, async (options) => {
    assert.equal(options.configPath, first.path);
    return report('deleted');
  });
  const final = await f.read(first.key);
  assert.equal(final.status, 'complete');
  assert.ok(Array.isArray(final.attempts));
  assert.equal(final.attempts.length, 2);
  await cleanupEvaluatorImages(f.context, async () =>
    assert.fail('completed input was replayed'),
  );
});

test('uncertain ownership, edited input and an unrelated experiment never invoke cleanup', async (t) => {
  const f = await fixture(t);
  const edited = await f.register();
  const shared = await f.register('c'.repeat(24), null);
  await writeFile(edited.path, '{}');
  const calls: string[] = [];
  const run = async (options: { configPath: string }) => {
    calls.push(options.configPath);
    return report();
  };
  await cleanupEvaluatorImages(
    f.context.extend({ experimentId: 'elsewhere' }),
    run,
  );
  assert.deepEqual((await f.read(shared.key)).attempts, []);
  await cleanupEvaluatorImages(f.context, run);
  assert.deepEqual(calls, []);
  assert.match(
    JSON.stringify((await f.read(edited.key)).attempts),
    /input changed/i,
  );
  assert.match(
    JSON.stringify((await f.read(shared.key)).attempts),
    /ownership/i,
  );
});

test('an aborted cleanup or an SDK error stays retryable with a recorded reason', async (t) => {
  const f = await fixture(t);
  const entry = await f.register();
  await cleanupEvaluatorImages(
    f.context.extend({
      signal: AbortSignal.abort(new Error('cleanup deadline')),
    }),
  );
  await cleanupEvaluatorImages(f.context, async () => {
    throw new Error('daemon unavailable');
  });
  const controller = new AbortController();
  const partial = report('deleted', 'skipped');
  await cleanupEvaluatorImages(
    f.context.extend({ signal: controller.signal }),
    async () => {
      controller.abort(new Error('interrupted after one removal'));
      return partial;
    },
  );
  const receipt = await f.read(entry.key);
  assert.equal(receipt.status, 'pending');
  assert.match(
    JSON.stringify(receipt.attempts),
    /cleanup deadline.*daemon unavailable/,
  );
  assert.ok(Array.isArray(receipt.attempts));
  assert.deepEqual(object(receipt.attempts.at(-1)).report, partial);
});

test('a changed configuration variable does not settle cleanup against a different ownership fingerprint', async (t) => {
  const f = await fixture(t);
  const prior = process.env.RSI_CLEANUP_TEST_IMAGE;
  t.after(() => {
    if (prior === undefined) delete process.env.RSI_CLEANUP_TEST_IMAGE;
    else process.env.RSI_CLEANUP_TEST_IMAGE = prior;
  });
  process.env.RSI_CLEANUP_TEST_IMAGE = 'fixture/original:1';
  const entry = await f.register(undefined, randomUUID(), {
    environment: {
      name: 'docker',
      config: { image: '${RSI_CLEANUP_TEST_IMAGE}' },
    },
  });
  process.env.RSI_CLEANUP_TEST_IMAGE = 'fixture/replacement:1';
  let calls = 0;
  const run = async () => {
    calls++;
    return report();
  };
  await cleanupEvaluatorImages(f.context, run);
  assert.equal(calls, 0);
  assert.equal((await f.read(entry.key)).status, 'pending');
  process.env.RSI_CLEANUP_TEST_IMAGE = 'fixture/original:1';
  await cleanupEvaluatorImages(f.context, run);
  assert.equal(calls, 1);
  assert.equal((await f.read(entry.key)).status, 'complete');
});

test('operator cleanup uses its call-owned kernel manifest and local evaluations create no image work', async (t) => {
  const f = await fixture(t);
  await f.register(undefined, randomUUID(), { environment: 'local' });
  assert.deepEqual(await f.context.facts.list(f.kind), []);
  const callId = 'call-' + 'd'.repeat(32);
  const directory = join(
    f.context.dataDirectory,
    'experiments',
    f.context.experimentId,
    'calls',
    callId,
  );
  await mkdir(directory, { recursive: true });
  const context = f.context.extend({
    callId,
    idempotencyKey: callId,
    directory,
  });
  const path = join(directory, 'sdk-config.json');
  const config = prepareKernelConfig(
    { benchmark: 'kernel', environment: 'docker' },
    {
      selected: { id: 'one', seed: 42 },
      operation: 'evaluate',
      directory,
      manifest: join(directory, 'sdk-input', 'manifest.json'),
    },
  );
  await writeFile(path, JSON.stringify(config));
  await recordImageCleanupInput({ context, kind: 'kernel' }, path, process.env);
  const issued: string[] = [];
  await cleanupEvaluatorImages(context, async (options) => {
    issued.push(options.configPath);
    return report('retained');
  });
  assert.deepEqual(issued, [path], JSON.stringify(await f.read(callId)));
  assert.equal((await f.read(callId)).status, 'complete');
});

test('installed SDK cleans a profile-selected Docker environment using an isolated empty inventory', async (t) => {
  const f = await fixture(t);
  const root = f.context.dataDirectory;
  const docker = join(root, 'docker.cjs');
  const log = join(root, 'commands.txt');
  // Node stands in for the Docker binary. Only the SDK's read-only requests are accepted.
  await writeFile(
    docker,
    `
    const command = require('node:path').basename(process.argv[1] ?? '');
    if (['info', 'image', 'ps'].includes(command)) {
      const args = [command, ...process.argv.slice(2)].join(' ');
      require('node:fs').appendFileSync(${JSON.stringify(log)}, args + '\\n');
      if (command === 'info') console.log('fixture-daemon');
      process.exit(command === 'image' && process.argv[2] !== 'ls' ? 1 : 0);
    }
  `,
  );
  const entry = await f.register(undefined, randomUUID(), {
    environment: { config: { dockerExecutable: process.execPath } },
  });
  const commandsSent: string[][] = [];
  const spawn = childProcess.spawn;
  t.mock.method(
    childProcess,
    'spawn',
    (command: string, args: string[], options: SpawnOptions) => {
      commandsSent.push(args.slice(3));
      return spawn(command, args, options);
    },
  );
  await cleanupEvaluatorImages(f.context, (options) =>
    runSdkCli({
      ...options,
      env: {
        ...options.env,
        EVALUATOR_CACHE_DIR: join(root, 'cache'),
        NODE_OPTIONS:
          '--require=' + JSON.stringify(docker.replaceAll('\\', '/')),
      },
    }),
  );
  const receipt = await f.read(entry.key);
  assert.equal(receipt.status, 'complete', JSON.stringify(receipt.attempts));
  assert.match(JSON.stringify(receipt.attempts), /fixture-daemon/);
  const commands = await readFile(log, 'utf8');
  assert.match(commands, /image ls/);
  assert.doesNotMatch(commands, /image rm/);
  assert.deepEqual(commandsSent, [['cleanup', 'images', entry.path, '--yes']]);
});
