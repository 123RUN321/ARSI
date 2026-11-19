import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(large.event, {
    type: 'message.completed',
    messageId: 'large',
    role: 'assistant',
    text: '',
  });
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

test('an Agent without trace adaptation succeeds when the recording directory cannot be created', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  await writeFile(join(f.context.directory, 'agent'), 'blocked');
  assert.deepEqual(
    await f.execute({
      async execute(_input, context) {
        assert.equal(context.signal.aborted, false);
        return { answer: 'accepted' };
      },
      async dispose() {},
    }),
    { answer: 'accepted' },
  );
});

test('an append failure disables recording without cancelling execution or changing its result', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  assert.deepEqual(
    await f.execute({
      async execute(_input, context) {
        await rm(join(f.context.directory, 'agent', 'payloads'), {
          recursive: true,
        });
        context.event.emit('rsi/agent-observation', {
          runId: 'main',
          event: {
            type: 'message.completed',
            messageId: 'large',
            role: 'assistant',
            text: 'x'.repeat(10000),
          },
        });
        context.event.emit('rsi/agent-observation', {
          runId: 'main',
          event: { type: 'run.finished', status: 'completed' },
        });
        assert.equal(context.signal.aborted, false);
        return { answer: 'accepted' };
      },
      async dispose() {},
    }),
    { answer: 'accepted' },
  );
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert.equal(records.items.length, 1);
});

test('a close failure cannot replace a successful result', async (t) => {
  const f = await agentFixture();
  t.after(() => f.close());
  const originalClose = FileAgentRecorder.prototype.close;
  t.mock.method(
    FileAgentRecorder.prototype,
    'close',
    function (this: FileAgentRecorder) {
      originalClose.call(this);
      throw new Error('Disk sync failed');
    },
  );
  assert.deepEqual(
    await f.execute({
      async execute() {
        return { answer: 'accepted' };
      },
      async dispose() {},
    }),
    { answer: 'accepted' },
  );
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

for (const outcome of ['invalid output', 'cancelled'] as const) {
  test(`recording failure does not hide ${outcome}`, async (t) => {
    const f = await agentFixture();
    t.after(() => f.close());
    await writeFile(join(f.context.directory, 'agent'), 'blocked');
    const controller = new AbortController();
    await assert.rejects(
      f.execute(
        {
          async execute() {
            if (outcome === 'cancelled')
              controller.abort(new Error('User cancelled'));
            return outcome === 'invalid output'
              ? {}
              : { answer: 'late result' };
          },
          async dispose() {},
        },
        f.request,
        f.context.extend({ signal: controller.signal }),
      ),
      outcome === 'invalid output' ? /Agent output/ : /User cancelled/,
    );
  });
}
