import type { JsonValue, JsonObject } from '../../src/contracts/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCodex } from '../../src/plugins/agent-codex/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('Codex drives app-server, records commentary and tools, and validates the terminal answer', async (t) => {
  const sent: JsonValue[] = [];
  const f = await agentFixture(async (spec, consume) => {
    assert(spec.interactive);
    const send = (message: JsonValue) => sent.push(message);
    for (const message of [
      { id: 1, result: {} },
      { id: 4, result: { config: { windows: {} }, origins: {} } },
      { id: 2, result: { thread: { id: 'thread1' }, model: 'test' } },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: {
            id: 'comment',
            type: 'agentMessage',
            phase: 'commentary',
            text: 'Reading',
          },
        },
      },
      {
        method: 'item/started',
        params: {
          threadId: 'thread1',
          item: {
            id: 'tool1',
            type: 'commandExecution',
            command: 'cat candidate/input.txt',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: {
            id: 'tool1',
            type: 'commandExecution',
            status: 'completed',
            aggregatedOutput: 'original',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: { id: 'answer', type: 'agentMessage', text: '{"answer":"ok"}' },
        },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread1', turn: { status: 'completed' } },
      },
    ])
      await consume(JSON.stringify(message), send);
  });
  t.after(() => f.close());
  const agent = await createAgentCodex(
    { executable: process.execPath },
    f.context,
  );
  assert.deepEqual(await f.execute(agent), { answer: 'ok' });
  assert.equal(sent.length, process.platform === 'win32' ? 4 : 3);
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert(
    records.items.some(
      (r) =>
        r.event?.type === 'message.completed' && r.event.phase === 'commentary',
    ),
  );
  assert(records.items.some((r) => r.event?.type === 'tool.completed'));
});

test('native agents reject an unenforceable modelCalls budget before launch', async (t) => {
  const f = await agentFixture(async () => {
    assert.fail('must not launch');
  });
  t.after(() => f.close());
  const agent = await createAgentCodex(
    { executable: process.execPath },
    f.context,
  );
  await assert.rejects(
    f.execute(
      agent,
      f.request,
      f.context.extend({
        scope: {
          id: 'test',
          signal: f.context.signal,
          limits: { modelCalls: 1 },
        },
      }),
    ),
    /cannot enforce/,
  );
});

for (const model of [undefined, 'explicit-model']) {
  test(`Codex preserves native instructions and forwards schema with model ${model ?? 'default'}`, async (t) => {
    const sent: Array<JsonObject> = [];
    const f = await agentFixture(async (spec, consume) => {
      const send = (message: JsonValue) => {
        sent.push(JSON.parse(JSON.stringify(message)));
      };
      assert(spec.args.includes('approval_policy="never"'));
      await consume(JSON.stringify({ id: 1, result: {} }), send);
      await consume(
        JSON.stringify({
          id: 4,
          result: { config: { windows: {} }, origins: {} },
        }),
        send,
      );
      await consume(
        JSON.stringify({ id: 2, result: { thread: { id: 't' } } }),
        send,
      );
      await consume(
        JSON.stringify({
          method: 'item/completed',
          params: {
            threadId: 't',
            item: { type: 'agentMessage', text: '{"answer":"ok"}' },
          },
        }),
        send,
      );
      await consume(
        JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 't', turn: { status: 'completed' } },
        }),
        send,
      );
    });
    t.after(() => f.close());
    const agent = await createAgentCodex(
      {
        executable: process.execPath,
        ...(model ? { model } : {}),
        thinkingLevel: 'high',
      },
      f.context,
    );
    assert.deepEqual(await f.execute(agent), { answer: 'ok' });
    assert.deepEqual(
      sent.find((message) => message.method === 'thread/start'),
      {
        id: 2,
        method: 'thread/start',
        params: {
          cwd: f.directory,
          ephemeral: true,
          ...(model ? { model } : {}),
          config: { model_reasoning_effort: 'high' },
          ...(process.platform === 'win32'
            ? { sandbox: 'danger-full-access' }
            : {}),
        },
      },
    );
    const turn = sent.find((message) => message.method === 'turn/start')!
      .params as JsonObject;
    assert.deepEqual(turn.outputSchema, f.request.outputSchema);
    assert.equal('baseInstructions' in turn, false);
    assert.equal('approvalPolicy' in turn, false);
  });
}

for (const [message, pattern] of [
  [
    { id: 1, error: { code: -32000, message: 'Native transport failed' } },
    /Native transport failed.*-32000/,
  ],
  [
    { id: 9, method: 'item/commandExecution/requestApproval', params: {} },
    /requires interactive input or approval/,
  ],
  [
    {
      method: 'turn/completed',
      params: {
        turn: {
          status: 'failed',
          error: { code: 'context_window_exceeded', message: 'Context full' },
        },
      },
    },
    /Context full.*context_window_exceeded/,
  ],
] as const) {
  test(`Codex preserves native failure: ${pattern.source}`, async (t) => {
    let launches = 0;
    const f = await agentFixture(async (_spec, consume) => {
      launches++;
      await consume(JSON.stringify(message), () => {});
    });
    t.after(() => f.close());
    const agent = await createAgentCodex(
      { executable: process.execPath },
      f.context,
    );
    await assert.rejects(f.execute(agent), pattern);
    assert.equal(launches, 1);
  });
}

for (const sandbox of ['elevated', 'unelevated'] as const) {
  test(
    `Codex retains the native Windows ${sandbox} sandbox in standalone execution`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const sent: Array<JsonObject> = [];
      const f = await agentFixture(async (spec, consume) => {
        assert(
          spec.args.includes('sandbox_workspace_write.network_access=true'),
        );
        assert.equal(
          Object.keys(spec.env ?? {}).some(
            (name) => name.toUpperCase() === 'CODEX_WINDOWS_REGISTERED_CORE',
          ),
          false,
        );
        const send = (message: JsonValue) =>
          sent.push(JSON.parse(JSON.stringify(message)));
        for (const message of [
          { id: 1, result: {} },
          {
            id: 4,
            result: {
              config: { windows: { sandbox } },
              origins: { 'windows.sandbox': {} },
            },
          },
          { id: 2, result: { thread: { id: 't' } } },
          {
            method: 'item/completed',
            params: {
              threadId: 't',
              item: { type: 'agentMessage', text: '{"answer":"ok"}' },
            },
          },
          {
            method: 'turn/completed',
            params: { threadId: 't', turn: { status: 'completed' } },
          },
        ])
          await consume(JSON.stringify(message), send);
      });
      t.after(() => f.close());
      const previous = process.env.CODEX_WINDOWS_REGISTERED_CORE;
      process.env.CODEX_WINDOWS_REGISTERED_CORE = '1';
      t.after(() => {
        if (previous === undefined)
          delete process.env.CODEX_WINDOWS_REGISTERED_CORE;
        else process.env.CODEX_WINDOWS_REGISTERED_CORE = previous;
      });
      const agent = await createAgentCodex(
        { executable: process.execPath },
        f.context,
      );
      assert.deepEqual(await f.execute(agent), { answer: 'ok' });
      assert.equal(
        (
          sent.find((message) => message.method === 'thread/start')!
            .params as JsonObject
        ).sandbox,
        'workspace-write',
      );
      assert.equal(process.env.CODEX_WINDOWS_REGISTERED_CORE, '1');
    },
  );
}
