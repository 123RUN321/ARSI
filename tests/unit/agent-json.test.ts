import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { agentContract } from '../../src/contracts/index.js';

test('framework disposal cancels active execution and waits for cleanup before disposing the plugin', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  const registry = new Registry();
  t.after(() => registry.dispose());
  let announceStart!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  let cleaned = false;
  let disposed = false;
  registry.registerOperation({
    id: 'test.disposable-agent',
    contract: agentContract,
    configSchema: { type: 'object', additionalProperties: false },
    async create() {
      return {
        async execute(_input, context) {
          announceStart();
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          cleaned = true;
          return { answer: 'late result' };
        },
        async dispose() {
          assert.equal(cleaned, true);
          disposed = true;
        },
      };
    },
  });
  const agent = await registry.createManagedOperation(
    'test.disposable-agent',
    {},
    f.context,
  );
  const rejected = assert.rejects(
    agent.execute(f.request, f.context),
    /Agent disposed/,
  );
  await started;
  await agent.dispose();
  await rejected;
  assert.equal(disposed, true);
  assert.equal(f.context.signal.aborted, false);
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert.equal(records.recording, 'closed');
});

test('an ordinary registered Agent gets recording and final Schema validation without hooks', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  let runs = 0;
  await assert.rejects(
    f.execute({
      async execute() {
        runs++;
        return { wrong: true };
      },
      async dispose() {},
    }),
    /Agent output/,
  );
  assert.equal(runs, 1);
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert.deepEqual(records.items, []);
  assert.equal(records.recording, 'closed');
});

test('an Agent without native observations seals an empty stream and leaves lifecycle facts to its receipt', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  assert.deepEqual(
    await f.execute({
      async execute() {
        return { answer: 'ok' };
      },
      async dispose() {},
    }),
    { answer: 'ok' },
  );
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert.deepEqual(records.items, []);
  assert.equal(records.recording, 'closed');
});

test('invalid optional observations report a gap without failing execution', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  await f.execute({
    async execute(_input, context) {
      // A JavaScript extension may publish a malformed native detail.
      Reflect.apply(context.event.emit, context.event, [
        'rsi/agent-observation',
        { invalid: true },
      ]);
      return { answer: 'ok' };
    },
    async dispose() {},
  });
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert.equal(records.recording, 'closed');
  assert.equal(records.gaps, 1);
  assert(
    records.items.some(
      (item) =>
        item.event?.type === 'observation.gap' &&
        item.event.reason.includes('Agent observation'),
    ),
  );
});
