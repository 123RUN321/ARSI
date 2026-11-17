import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileAgentRecorder,
  readAgentRecords,
  readAgentPayload,
} from '../../src/runtime/storage/agent-records.js';
import { agentFixture } from '../fixtures/agent-execution.js';

test('record pagination reaches beyond the former 4 MiB prefix without dropping full payloads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-agent-records-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = new FileAgentRecorder(root);
  for (let index = 0; index < 5000; index++)
    writer.record({
      runId: 'main',
      event: {
        type: 'message.completed',
        messageId: String(index),
        role: 'assistant',
        text: 'x'.repeat(1000),
      },
    });
  const text = '完整内容'.repeat(20000);
  writer.record({
    runId: 'main',
    event: {
      type: 'message.completed',
      messageId: 'large',
      role: 'assistant',
      text,
    },
  });
  writer.record({
    runId: 'main',
    event: { type: 'run.finished', status: 'completed' },
  });
  writer.close();
  const page = await readAgentRecords(root, 4999, 100, true);
  assert.equal(page.total, 5002);
  assert.equal(page.items[0]?.sequence, 5000);
  const large = page.items[1]!;
  assert.equal(large.event, null);
  assert(large.payload);
  assert.equal(
    JSON.parse((await readAgentPayload(root, large.payload.ref)).toString())
      .text,
    text,
  );
  assert.equal(page.recording, 'closed');
  await assert.rejects(readAgentPayload(root, '../events.jsonl'), /Invalid/);
});

test('an interrupted trailing append exposes only complete records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-agent-interrupted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = new FileAgentRecorder(root);
  writer.record({
    runId: 'main',
    event: { type: 'run.started', backend: 'test', parentRunId: null },
  });
  writer.close();
  await appendFile(join(root, 'agent', 'events.jsonl'), '{"sequence":2');
  const page = await readAgentRecords(root, 0, 100, true);
  assert.equal(page.items.length, 1);
  assert.equal(page.recording, 'interrupted');
});

test('a recording failure cancels execution and cannot publish a successful result', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  let stopped = false;
  const agent = {
    async execute(
      _input: import('../../src/contracts/index.js').JsonValue,
      context: import('../../src/contracts/index.js').RuntimeContext,
    ) {
      await rm(join(f.context.directory, 'agent', 'payloads'), {
        recursive: true,
      });
      assert.throws(() =>
        context.event.emit('rsi/agent-observation', {
          runId: 'main',
          event: {
            type: 'message.completed',
            messageId: 'large',
            role: 'assistant',
            text: 'x'.repeat(10000),
          },
        }),
      );
      stopped = context.signal.aborted;
      return { answer: 'must not be accepted' };
    },
    async dispose() {},
  };
  await assert.rejects(f.execute(agent));
  assert(stopped);
});

test('unconfirmed process cleanup remains unknown when closing the record also fails', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  const unknown = Object.assign(
    new Error('Process stop could not be confirmed'),
    { status: 'unknown' },
  );
  const originalClose = FileAgentRecorder.prototype.close;
  t.mock.method(
    FileAgentRecorder.prototype,
    'close',
    function (this: FileAgentRecorder) {
      originalClose.call(this);
      throw new Error('Disk sync failed');
    },
  );
  await assert.rejects(
    f.execute({
      async execute() {
        throw unknown;
      },
      async dispose() {},
    }),
    (error) => error === unknown,
  );
});
