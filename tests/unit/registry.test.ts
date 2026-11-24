import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import {
  defineContract,
  RuntimeContext,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { withBindingInstance } from '../../src/runtime/manager/instances.js';
import { FileFacts } from '../../src/runtime/storage/index.js';

function definition(label: string): OperationDefinition {
  return {
    id: 'registry.worker',
    implementationDigest: label,
    contract: defineContract({
      id: 'contract.registry-worker',
      input_schema: { type: 'string' },
      output_schema: { type: 'string' },
    }),
    configSchema: {
      type: 'object',
      properties: { suffix: { type: 'string', default: 'default' } },
      required: ['suffix'],
      additionalProperties: false,
    },
    async create(config) {
      return {
        execute: async () => `${label}:${config.suffix}`,
        async dispose() {},
      };
    },
  };
}

test('managed factories belong to the Registry even when plugin IDs coincide', async (t) => {
  const first = new Registry();
  const second = new Registry();
  t.after(() => first.dispose());
  t.after(() => second.dispose());
  first.registerOperation(definition('first'));
  second.registerOperation(definition('second'));
  const context = new RuntimeContext();
  for (const [registry, expected] of [
    [first, 'first:default'],
    [second, 'second:default'],
  ] as const) {
    const operation = await registry.createManagedOperation(
      'registry.worker',
      {},
      context,
    );
    try {
      assert.equal(await operation.execute('input', context), expected);
    } finally {
      await operation.dispose();
    }
  }
});

test('managed creation rejects unknown and unregistered plugins', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  const context = new RuntimeContext();
  await assert.rejects(
    async () => registry.createManagedOperation('unknown', {}, context),
    /Unknown plugin unknown/,
  );
  const unregister = registry.registerOperation(definition('worker'));
  unregister();
  await assert.rejects(
    async () => registry.createManagedOperation('registry.worker', {}, context),
    /Unknown plugin registry.worker/,
  );
});

test('registration rejects a doctor field and leaves instance creation to its caller', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  const invalid = { ...definition('invalid'), doctor: () => ({ checks: [] }) };
  assert.throws(
    () => registry.registerOperation(invalid),
    /unknown field doctor/,
  );
  assert.deepEqual(registry.catalog().plugins, []);
});

test('managed configuration is validated before factory effects', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  let creations = 0;
  const worker = definition('worker');
  registry.registerOperation({
    ...worker,
    async create(config, context) {
      creations++;
      return worker.create(config, context);
    },
  });
  await assert.rejects(
    async () =>
      registry.createManagedOperation(
        worker.id,
        { suffix: 42 },
        new RuntimeContext(),
      ),
    /plugin config.*suffix/,
  );
  assert.equal(creations, 0);
});

test('standalone creation fills configuration defaults and forwards disposal', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  const worker = definition('worker');
  let disposals = 0;
  registry.registerOperation({
    ...worker,
    async create(config, context) {
      const operation = await worker.create(config, context);
      return {
        execute: operation.execute,
        async dispose() {
          disposals++;
        },
      };
    },
  });
  const context = new RuntimeContext();
  const operation = await registry.get(worker.id).create({}, context);
  assert.equal(await operation.execute('input', context), 'worker:default');
  await operation.dispose();
  assert.equal(disposals, 1);
});

test('standalone execution rejects invalid input before effects and invalid output after effects', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  let executions = 0;
  const worker = definition('worker');
  registry.registerOperation({
    ...worker,
    async create() {
      return {
        async execute() {
          executions++;
          return 42;
        },
        async dispose() {},
      };
    },
  });
  const context = new RuntimeContext();
  const operation = await registry.get(worker.id).create({}, context);
  t.after(() => operation.dispose());
  await assert.rejects(operation.execute(42, context), /plugin input/);
  assert.equal(executions, 0);
  await assert.rejects(operation.execute('input', context), /plugin output/);
  assert.equal(executions, 1);
});

test('unregister and late Cordis teardown preserve a replacement registration', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  const worker = definition('original');
  const unregister = registry.registerOperation(worker);
  const fibers = [...registry.context.registry.values()].flatMap((runtime) => [
    ...runtime.fibers,
  ]);
  await Promise.all(fibers.map((fiber) => fiber.await()));
  const originalIdentity = registry.identity(worker.id);
  const release = registry.retain(worker.id);
  assert.throws(unregister, /still in use/);
  await assert.rejects(registry.dispose(), /still in use/);
  release();
  unregister();
  registry.registerOperation(definition('replacement'));
  await Promise.all(fibers.map((fiber) => fiber.await()));
  unregister();
  assert.deepEqual(registry.catalog(), {
    plugins: [worker.id],
    policies: [],
  });
  assert.notEqual(registry.identity(worker.id), originalIdentity);
  const context = new RuntimeContext();
  const operation = await registry.createManagedOperation(
    worker.id,
    {},
    context,
  );
  try {
    assert.equal(
      await operation.execute('input', context),
      'replacement:default',
    );
  } finally {
    await operation.dispose();
  }
  await registry.dispose();
  assert.deepEqual(registry.catalog(), { plugins: [], policies: [] });
});

test('a binding request retains only its temporary instance until reply and disposal settle', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  const worker = definition('worker');
  const barrier = new EventEmitter();
  const entered = once(barrier, 'entered');
  const finish = once(barrier, 'finish');
  const disposed: string[] = [];
  const unload = registry.registerOperation({
    ...worker,
    async create(config, ctx) {
      ctx.event.on('rsi/cleanup', async (request) => {
        assert.equal(request.bindingId, ctx.bindingId);
        assert.throws(
          () => ctx.event.emit('rsi/cleanup', request),
          /explicit request to a binding/,
        );
        barrier.emit('entered');
        await finish;
        return [{ key: String(config.suffix), status: 'preview' }];
      });
      return {
        async execute() {
          return assert.fail('unexpected execution');
        },
        async dispose() {
          await Promise.resolve();
          disposed.push(ctx.bindingId);
        },
      };
    },
  });
  registry.registerOperation({
    ...worker,
    id: 'registry.peer',
    async create() {
      return assert.fail('unaddressed plugin');
    },
  });
  const context = new RuntimeContext().extend({
    experimentId: 'test',
    bindingId: 'left',
    dataDirectory: '.',
    facts: new FileFacts('.'),
    signal: new AbortController().signal,
  });
  const request = () =>
    withBindingInstance(
      registry,
      { plugin: worker.id, config: {} },
      context,
      'rsi/cleanup',
      (target, event) =>
        target.serial(target, event, {
          ...context,
          dryRun: true,
          pluginId: worker.id,
        }),
    );
  const reply = request();
  await Promise.race([
    entered,
    reply.then(() => assert.fail('expected a pending reply')),
  ]);
  try {
    assert.throws(unload, /in use/);
    assert.deepEqual(disposed, []);
  } finally {
    barrier.emit('finish');
  }
  assert.deepEqual(await reply, [{ key: 'default', status: 'preview' }]);
  assert.deepEqual(disposed, ['left']);
  unload();
  await assert.rejects(request(), /Unknown plugin/);
  registry.registerOperation(worker);
  assert.equal(await request(), undefined);
});
