import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

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
  assert.equal(records.items[0]?.type, 'observation.gap');
  assert.equal(records.recording, 'closed');
});

test('an Agent without native observations records a gap and leaves lifecycle facts to its receipt', async (t) => {
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
  assert.equal(records.items.length, 1);
  assert.equal(records.items[0]?.type, 'observation.gap');
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
  assert(
    records.items.some(
      (item) =>
        item.event?.type === 'observation.gap' &&
        item.event.reason.includes('Agent observation'),
    ),
  );
});
