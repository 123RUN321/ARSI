import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  defineContract,
  type OperationDefinition,
  type JsonObject,
} from '../../src/contracts/index.js';
import { managerFixture } from '../helpers/manager-fixture.js';

for (const status of ['running', 'unknown', 'failed', 'cancelled']) {
  test(`explicit resume reconciles ${status} calls without replay or duplicate reservations`, async () => {
    let executions = 0;
    let recoveries = 0;
    const plugin: OperationDefinition = {
      id: 'test.recoverable',
      contract: defineContract({
        id: 'contract.recoverable',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
      }),
      configSchema: { type: 'object' },
      async create() {
        return {
          async execute(_input, ctx) {
            executions++;
            await ctx.charge('evaluationRuns', 1);
            throw new Error('interrupted external operation');
          },
          async recover(_input, prior) {
            recoveries++;
            assert.equal(prior.status, status);
            return { result: 'existing external operation' };
          },
          async dispose() {},
        };
      },
    };
    const f = await managerFixture(async () => ({}), {
      plugins: [plugin],
      bindings: { work: { plugin: plugin.id, config: {} } },
      policy: {
        steps: [{ id: 'work', type: 'invoke', use: 'work', with: {} }],
        output: '${{ steps.work.output }}',
      },
    });
    try {
      await assert.rejects(f.run(), /interrupted external operation/);
      const before = await f.manager.get('test');
      const budget = await f.manager.facts.read('budgets', 'test');
      const call = (await f.manager.facts.list('calls')).find(
        (c) => c.pluginId === plugin.id,
      )!;
      const interrupted: JsonObject = { ...call, status };
      delete interrupted.finishedAt;
      await f.manager.facts.write('calls', String(call.callId), interrupted);
      const resumed = await f.manager.run(
        join(f.manager.rootDirectory, 'recipe.yaml'),
        { id: 'test', resume: true },
      );
      assert.equal(resumed.status, 'succeeded');
      assert.equal(resumed.startedAt, before.startedAt);
      assert.deepEqual(await f.manager.facts.read('budgets', 'test'), budget);
      assert.equal(executions, 1);
      assert.equal(recoveries, 1);
      const settled = await f.manager.facts.read('calls', String(call.callId));
      assert.equal(settled.startedAt, call.startedAt);
      assert.equal(settled.status, 'succeeded');
      assert.deepEqual(
        await f.manager.facts.read(
          'call-attempts',
          String(settled.recoveredFrom),
        ),
        interrupted,
      );
    } finally {
      await f.dispose();
    }
  });
}

test('unconfirmed calls without a recovery hook still fail closed', async () => {
  const f = await managerFixture(async () => {
    throw new Error('interrupted');
  });
  try {
    await assert.rejects(f.run(), /interrupted/);
    const call = (await f.manager.facts.list('calls')).find(
      (c) => c.pluginId === 'test.driver',
    )!;
    await f.manager.facts.write('calls', String(call.callId), {
      ...call,
      status: 'running',
    });
    await assert.rejects(
      f.manager.run(join(f.manager.rootDirectory, 'recipe.yaml'), {
        id: 'test',
        resume: true,
      }),
      /unconfirmed\/failed effects/,
    );
  } finally {
    await f.dispose();
  }
});
