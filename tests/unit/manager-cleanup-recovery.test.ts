import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { managerFixture } from '../helpers/manager-fixture.js';

test('resume retains the original start time after application creation fails before its first charge', async () => {
  const fixture = await managerFixture(async () => ({}));
  const registry = fixture.manager.options.registry;
  const create = registry.createManagedOperation.bind(registry);
  const failure = new Error('application temporarily unavailable');
  let attempts = 0;
  registry.createManagedOperation = async (id, config, context) => {
    if (id === 'test.application' && ++attempts === 1) throw failure;
    return create(id, config, context);
  };
  try {
    await assert.rejects(fixture.run(), (error) => error === failure);
    const failed = await fixture.manager.get('test');
    assert.deepEqual(await fixture.manager.facts.list('calls'), []);
    assert.deepEqual(await fixture.manager.facts.read('budgets', 'test'), {
      scopes: {},
    });
    await fixture.manager.dispose();
    const resumed = await fixture.manager.run(
      join(fixture.manager.rootDirectory, 'recipe.yaml'),
      { id: 'test', resume: true },
    );
    assert.equal(resumed.status, 'succeeded');
    assert.equal(resumed.startedAt, failed.startedAt);
    assert.equal(attempts, 2);
    assert.equal(
      (await fixture.manager.facts.read('budgets', 'test')).operations,
      2,
    );
  } finally {
    registry.createManagedOperation = create;
    await fixture.dispose();
  }
});

test('startup budget publication failure prevents plugin execution', async () => {
  let created = false;
  const fixture = await managerFixture(async () => ({}));
  const registry = fixture.manager.options.registry;
  const create = registry.createManagedOperation.bind(registry);
  registry.createManagedOperation = async (id, config, context) => {
    created = true;
    return create(id, config, context);
  };
  const write = fixture.manager.facts.write.bind(fixture.manager.facts);
  const failure = new Error('budget storage unavailable');
  fixture.manager.facts.write = async (kind, id, value) => {
    if (kind === 'budgets') throw failure;
    await write(kind, id, value);
  };
  try {
    await assert.rejects(fixture.run(), (error) => error === failure);
    assert.equal(created, false);
    assert.deepEqual(await fixture.manager.facts.list('calls'), []);
    assert.equal((await fixture.manager.get('test')).status, 'failed');
  } finally {
    fixture.manager.facts.write = write;
    registry.createManagedOperation = create;
    await fixture.dispose();
  }
});

test('definition publication failure releases startup ownership before any plugin calls', async () => {
  let executions = 0;
  const fixture = await managerFixture(async () => {
    executions++;
    return {};
  });
  const failure = new Error('definition storage unavailable');
  const write = fixture.manager.facts.write.bind(fixture.manager.facts);
  fixture.manager.facts.write = async (kind, id, value) => {
    if (kind === 'definitions') throw failure;
    await write(kind, id, value);
  };
  try {
    await assert.rejects(fixture.run(), (error) => error === failure);
    await fixture.manager.dispose();
    assert.equal((await fixture.manager.get('test')).status, 'failed');
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'succeeded',
    );
    assert.deepEqual(await fixture.manager.facts.list('calls'), []);
    assert.deepEqual(await fixture.manager.facts.list('event-diagnostics'), []);
    assert.equal(executions, 0);
    const recipe = join(fixture.manager.rootDirectory, 'recipe.yaml');
    await assert.rejects(
      fixture.manager.run(recipe, { id: 'test' }),
      /Experiment already exists/,
    );
    fixture.manager.facts.write = write;
    assert.equal(
      (await fixture.manager.run(recipe, { id: 'recovered' })).status,
      'succeeded',
    );
    assert.equal(executions, 1);
  } finally {
    fixture.manager.facts.write = write;
    await fixture.dispose();
  }
});

test('dispose recovers a failed durable cleanup marker before attempting each disposer once', async () => {
  let disposals = 0;
  const fixture = await managerFixture(async () => ({}), {
    async disposeDriver() {
      disposals++;
    },
  });
  const write = fixture.manager.facts.write.bind(fixture.manager.facts);
  fixture.manager.facts.write = async (kind, id, value) => {
    if (kind === 'cleanup') throw new Error('cleanup storage unavailable');
    await write(kind, id, value);
  };
  try {
    await assert.rejects(fixture.run(), /cleanup storage unavailable/);
    assert.equal(disposals, 0);
    await assert.rejects(fixture.manager.dispose(), /cleanup failed/i);
    assert.equal(disposals, 0);
    fixture.manager.facts.write = write;
    await Promise.all([fixture.manager.dispose(), fixture.manager.dispose()]);
    assert.equal(disposals, 1);
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'succeeded',
    );
    await fixture.manager.dispose();
    assert.equal(disposals, 1);
    const recipe = join(fixture.manager.rootDirectory, 'recipe.yaml');
    assert.equal(
      (await fixture.manager.run(recipe, { id: 'test', resume: true })).status,
      'succeeded',
    );
    assert.equal(disposals, 1);
  } finally {
    fixture.manager.facts.write = write;
    await fixture.dispose();
  }
});
