import {
  readAgentRecords,
  readAgentPayload,
} from '../../src/runtime/storage/agent-records.js';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { OperationDefinition } from '../../src/contracts/index.js';
import { agentContract } from '../../src/contracts/plugin-types/index.js';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';
import { object, string } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

test('Manager invokes exact Agent bindings and never falls back to an implementation ID', async () => {
  let executions = 0;
  const agent: OperationDefinition = {
    id: 'test.shared-agent',
    contract: agentContract,
    configSchema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
    },
    async create(config) {
      const label = string(config.label);
      return {
        async execute() {
          executions++;
          return { label };
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      const request = {
        goal: 'test routing',
        cwd: await prepareAgentProject(context, 'test', {}, [], []),
        outputSchema: { type: 'object' },
      };
      assert.deepEqual(await context.invokeAgent('second', request), {
        label: 'second',
      });
      assert.deepEqual(await context.invokeAgent('first', request), {
        label: 'first',
      });
      assert.deepEqual(await context.invokeAgent('agent.default', request), {
        label: 'default',
      });
      const before = await context.facts.read('budgets', context.experimentId);
      await assert.rejects(
        context.invokeAgent(agent.id, request),
        /Unknown Agent test.shared-agent/,
      );
      await assert.rejects(
        context.invokeAgent('missing', request),
        /Unknown Agent missing/,
      );
      await assert.rejects(
        context.invokeAgent('driver', request),
        /does not implement contract\.agent/,
      );
      assert.deepEqual(
        await context.facts.read('budgets', context.experimentId),
        before,
      );
      const receipts = (await context.facts.list('calls')).filter(
        (call) => call.pluginId === agent.id,
      );
      assert.equal(receipts.length, 3);
      for (const receipt of receipts) {
        assert.equal(receipt.contractId, 'contract.agent');
        assert.equal(receipt.status, 'succeeded');
        assert.equal(
          string(object(receipt.output).label),
          receipt.bindingId === 'agent.default' ? 'default' : receipt.bindingId,
        );
        const records = await readAgentRecords(
          join(
            context.dataDirectory,
            'experiments',
            context.experimentId,
            'calls',
            string(receipt.callId),
          ),
          0,
          100,
          true,
        );
        assert.equal(records.recording, 'closed');
        assert.deepEqual(
          records.items.map((item) => item.type),
          ['observation.gap'],
        );
      }
      assert.equal(executions, 3);
      return {};
    },
    {
      plugins: [agent],
      bindings: {
        first: { plugin: agent.id, config: { label: 'first' } },
        second: { plugin: agent.id, config: { label: 'second' } },
        'agent.default': { plugin: agent.id, config: { label: 'default' } },
      },
    },
  );
  try {
    assert.equal((await fixture.run()).status, 'succeeded');
  } finally {
    await fixture.dispose();
  }
});

test('Runtime applies a binding deadline to an ordinary Agent with a strict plugin Schema', async () => {
  let executions = 0;
  const agent: OperationDefinition = {
    id: 'test.deadline-agent',
    contract: agentContract,
    configSchema: { type: 'object', additionalProperties: false },
    async create(config) {
      assert.deepEqual(config, {});
      return {
        async execute(_input, context) {
          executions++;
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          return { late: true };
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      const cwd = await prepareAgentProject(context, 'test', {}, [], []);
      const scope = context.extend({
        scope: { id: 'deadline', limits: {}, signal: context.signal },
      });
      await assert.rejects(
        scope.invokeAgent('agent', {
          goal: 'deadline',
          cwd,
          outputSchema: { type: 'object' },
        }),
        /execution timed out/,
      );
      assert.equal(context.signal.aborted, false);
      const receipt = (await context.facts.list('calls')).find(
        (call) => call.pluginId === agent.id,
      )!;
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.output, undefined);
      return {};
    },
    {
      plugins: [agent],
      bindings: {
        agent: { plugin: agent.id, config: {}, execution: { timeoutMs: 30 } },
      },
    },
  );
  try {
    assert.equal((await fixture.run()).status, 'succeeded');
    assert.equal(executions, 1);
  } finally {
    await fixture.dispose();
  }
});

for (const status of ['failed', 'cancelled'] as const) {
  test(`a framework-admitted ${status} retry preserves the previous conversation and starts a fresh record`, async () => {
    let executions = 0;
    const agent: OperationDefinition = {
      id: 'test.retry-agent',
      contract: agentContract,
      configSchema: { type: 'object', additionalProperties: false },
      async create() {
        return {
          async execute(_input, context) {
            executions++;
            context.event.emit('rsi/agent-observation', {
              runId: 'main',
              event: {
                type: 'message.completed',
                messageId: 'answer',
                role: 'assistant',
                text: `attempt ${executions}`,
              },
            });
            if (executions === 1)
              context.event.emit('rsi/agent-observation', {
                runId: 'main',
                event: {
                  type: 'tool.completed',
                  toolCallId: 'large',
                  status: 'failed',
                  output: 'archived payload'.repeat(1000),
                },
              });
            if (executions === 1)
              throw Object.assign(new Error('retryable fixture failure'), {
                status,
              });
            return { answer: 'ok' };
          },
          async canRetry() {
            return true;
          },
          async dispose() {},
        };
      },
    };
    const fixture = await managerFixture(
      async (context) => {
        const cwd = await prepareAgentProject(context, 'retry', {}, [], []);
        const request = {
          goal: 'retry',
          cwd,
          outputSchema: { type: 'object' },
        };
        const scope = context.extend({
          scope: { id: 'retry', limits: {}, signal: context.signal },
        });
        await assert.rejects(
          scope.invokeAgent('agent', request),
          /retryable fixture failure/,
        );
        assert.deepEqual(await scope.invokeAgent('agent', request), {
          answer: 'ok',
        });
        const receipt = (await context.facts.list('calls')).find(
          (call) => call.pluginId === agent.id,
        )!;
        const previous = await context.facts.read(
          'call-attempts',
          string(receipt.recoveredFrom),
        );
        assert.equal(previous.status, status);
        const callDirectory = join(
          context.dataDirectory,
          'experiments',
          context.experimentId,
          'calls',
          string(receipt.callId),
        );
        const current = await readAgentRecords(callDirectory, 0, 100, true);
        const archived = await readAgentRecords(
          join(callDirectory, 'agent-attempts', string(receipt.recoveredFrom)),
          0,
          100,
          true,
        );
        assert(
          current.items.some(
            (item) =>
              item.event?.type === 'message.completed' &&
              item.event.text === 'attempt 2',
          ),
        );
        assert(
          !current.items.some(
            (item) =>
              item.event?.type === 'message.completed' &&
              item.event.text === 'attempt 1',
          ),
        );
        assert(
          archived.items.some(
            (item) =>
              item.event?.type === 'message.completed' &&
              item.event.text === 'attempt 1',
          ),
        );
        const payload = archived.items.find((item) => item.payload)?.payload;
        assert(payload);
        const body = JSON.parse(
          (
            await readAgentPayload(
              join(
                callDirectory,
                'agent-attempts',
                string(receipt.recoveredFrom),
              ),
              payload.ref,
            )
          ).toString('utf8'),
        );
        assert.equal(body.output, 'archived payload'.repeat(1000));
        assert.equal(current.items[0]?.sequence, 1);
        assert.equal(archived.items[0]?.sequence, 1);
        return {};
      },
      {
        plugins: [agent],
        bindings: { agent: { plugin: agent.id, config: {} } },
      },
    );
    try {
      assert.equal((await fixture.run()).status, 'succeeded');
      assert.equal(executions, 2);
    } finally {
      await fixture.dispose();
    }
  });
}

test('an unknown outcome cannot replace its conversation even if the plugin permits retries', async () => {
  let executions = 0;
  const agent: OperationDefinition = {
    id: 'test.unknown-agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          executions++;
          throw Object.assign(new Error('unconfirmed fixture'), {
            status: 'unknown',
          });
        },
        async canRetry() {
          return true;
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      const scope = context.extend({
        scope: { id: 'unknown', signal: context.signal, limits: {} },
      });
      const request = {
        cwd: await prepareAgentProject(context, 'unknown', {}, [], []),
        goal: 'unknown',
        outputSchema: { type: 'object' },
      };
      await assert.rejects(
        scope.invokeAgent('agent', request),
        /unconfirmed fixture/,
      );
      const receipt = (await context.facts.list('calls')).find(
        (call) => call.pluginId === agent.id,
      )!;
      const directory = join(
        context.dataDirectory,
        'experiments',
        context.experimentId,
        'calls',
        string(receipt.callId),
      );
      const before = await readAgentRecords(directory, 0, 100, true);
      await assert.rejects(
        scope.invokeAgent('agent', request),
        /unconfirmed\/failed effects/,
      );
      assert.deepEqual(await readAgentRecords(directory, 0, 100, true), before);
      assert.deepEqual(await context.facts.list('call-attempts'), []);
      return {};
    },
    { plugins: [agent], bindings: { agent: { plugin: agent.id, config: {} } } },
  );
  try {
    await fixture.run();
    assert.equal(executions, 1);
  } finally {
    await fixture.dispose();
  }
});
