import { FileAgentRecorder } from '../../src/runtime/storage/agent-records.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedObservation } from '../fixtures/observation/seed.js';
import { ObservationQueries } from '../../src/runtime/services/observation.js';
import { traceRows } from '../../web/features/experiments/trace-model.js';
import { parseCallTrace } from '../../web/api/observation-client.js';

test('agent records preserve content without redaction and enforce call ownership', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  await facts.write('calls', 'agent-call', {
    experimentId: 'run-alpha',
    callId: 'agent-call',
    pluginId: 'custom.chat',
    contractId: 'contract.agent',
    bindingId: 'agent',
    status: 'running',
  });
  const query = new ObservationQueries(facts, artifacts, directory);
  const location = join(
    directory,
    'experiments',
    'run-alpha',
    'calls',
    'agent-call',
  );
  const writer = new FileAgentRecorder(location);
  writer.record({
    runId: 'main',
    event: {
      type: 'message.completed',
      messageId: 'm1',
      role: 'assistant',
      text: 'fixture-private-value',
    },
  });
  writer.record({
    runId: 'main',
    event: {
      type: 'message.completed',
      messageId: 'm2',
      role: 'assistant',
      phase: 'final_answer',
      text: 'large response '.repeat(600),
    },
  });
  writer.record({
    runId: 'child',
    event: {
      type: 'message.completed',
      messageId: 'child-answer',
      role: 'assistant',
      phase: 'final_answer',
      text: 'Delegated response',
    },
  });
  writer.record({
    runId: 'main',
    event: { type: 'run.finished', status: 'completed' },
  });
  await writer.close();
  assert.equal(
    (await query.calls('run-alpha', 0, 100)).items.find(
      (call) => call.callId === 'agent-call',
    )?.contractId,
    'contract.agent',
  );
  const result = parseCallTrace(
    await query.callTrace('run-alpha', 'agent-call', 0, 1),
  );
  assert(
    JSON.stringify(result.items[0].event).includes('fixture-private-value'),
  );
  assert.equal(result.total, 4);
  assert.equal(result.nextOffset, 1);
  assert.equal(traceRows(result.items)[0].body, 'fixture-private-value');
  assert.deepEqual(result.finalResponses, [
    { runId: 'main', sequence: 2 },
    { runId: 'child', sequence: 3 },
  ]);
  const mainResponse = await query.callTrace('run-alpha', 'agent-call', 1, 1);
  assert.equal(mainResponse.items[0].sequence, 2);
  assert.ok(mainResponse.items[0].payloadRef);
  const childResponse = await query.callTrace('run-alpha', 'agent-call', 2, 1);
  assert.equal(traceRows(childResponse.items)[0].body, 'Delegated response');
  await assert.rejects(query.callTrace('run-other', 'agent-call'), /not found/);
  await assert.rejects(
    query.callTrace('run-alpha', 'agent-call', -1),
    /Invalid/,
  );
});

test('candidate creation paths follow recorded parent calls rather than later evaluations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-origins-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  await facts.write('candidates', 'round-candidate', {
    experimentId: 'run-alpha',
    ref: 'round-candidate',
    parentRef: 'base',
    artifactRef: 'artifact-placeholder',
  });
  await facts.write('calls', 'propose', {
    experimentId: 'run-alpha',
    callId: 'propose',
    path: 'loop/2/propose',
    parentCallId: 'root',
    output: { candidateRef: 'round-candidate' },
  });
  await facts.write('calls', 'commit', {
    experimentId: 'run-alpha',
    callId: 'commit',
    path: 'steps/iteration-7',
    parentCallId: 'propose',
    output: { candidateRef: 'round-candidate' },
  });
  const result = await new ObservationQueries(facts, artifacts).candidates(
    'run-alpha',
  );
  assert.equal(
    result.items.find((item) => item.ref === 'round-candidate')?.originPath,
    'loop/2/propose',
  );
});

test('instructions project the owned submission and only instruction files from the saved workspace', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-instructions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  const workspaceRef = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: 'AGENTS.md',
        mode: 0o644,
        base64: Buffer.from('Workspace guide secret-fixture').toString(
          'base64',
        ),
      },
      {
        path: 'candidate/private.txt',
        mode: 0o644,
        base64: Buffer.from('excluded').toString('base64'),
      },
    ],
  });
  await facts.write('calls', 'prompt-call', {
    experimentId: 'run-alpha',
    callId: 'prompt-call',
    pluginId: 'agent.pi',
    bindingId: 'agent',
    status: 'succeeded',
    agentProjectArtifactRef: workspaceRef,
    input: { api_key: 'secret-fixture' },
  });
  const writer = new FileAgentRecorder(
    join(directory, 'experiments', 'run-alpha', 'calls', 'prompt-call'),
  );
  writer.record({
    runId: 'main',
    event: {
      type: 'task.submitted',
      text: 'Follow the recorded instructions. secret-fixture',
      outputSchema: { type: 'object' },
    },
  });
  writer.record({
    runId: 'child',
    event: {
      type: 'task.submitted',
      text: 'Check the baseline.',
      outputSchema: { type: 'string' },
    },
  });
  const prompt = 'Review secret-fixture. ' + 'x'.repeat(9000);
  writer.record({
    runId: 'main',
    event: {
      type: 'tool.started',
      name: 'spawnAgent',
      toolCallId: 'spawn',
      input: { type: 'collabAgentToolCall', tool: 'spawnAgent', prompt },
    },
  });
  writer.record({
    runId: 'main',
    event: {
      type: 'tool.completed',
      name: 'spawnAgent',
      toolCallId: 'spawn',
      status: 'succeeded',
      output: {
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        receiverThreadIds: ['delegated'],
        details: 'x'.repeat(9000),
      },
    },
  });
  writer.record({
    runId: 'main',
    event: {
      type: 'subagent.activity',
      activity: 'started',
      childRunId: 'lifecycle-only',
    },
  });
  writer.record({
    runId: 'main',
    event: {
      type: 'subagent.activity',
      activity: 'started',
      childRunId: 'recorded-delegation',
      text: prompt,
    },
  });
  await writer.close();
  const query = new ObservationQueries(facts, artifacts, directory);
  const { parseCallInstructions } = await import(
    '../../web/api/observation-client.js'
  );
  const result = parseCallInstructions(
    await query.callInstructions('run-alpha', 'prompt-call'),
  );
  assert.equal(
    result.submittedTask?.text,
    'Follow the recorded instructions. [REDACTED]',
  );
  assert.equal(result.submittedTask?.truncated, false);
  assert.equal(JSON.parse(result.outputSchema?.text ?? 'null').type, 'object');
  assert.deepEqual(result.workspaceInstructions, [
    {
      path: 'AGENTS.md',
      content: { text: 'Workspace guide [REDACTED]', truncated: false },
    },
  ]);
  const trace = await query.callTrace('run-alpha', 'prompt-call');
  assert.equal(trace.recording, 'closed');
  assert.deepEqual(trace.items[0].event, { type: 'task.submitted' });
  const { default: Fastify } = await import('fastify');
  const { registerObservationRoutes } = await import(
    '../../src/entries/web/observation.js'
  );
  const app = Fastify();
  t.after(() => app.close());
  registerObservationRoutes(app, query);
  const traceRoute =
    '/api/observation/experiments/run-alpha/calls/prompt-call/trace';
  const largerPage = await app.inject(`${traceRoute}?limit=300`);
  assert.equal(largerPage.statusCode, 200);
  assert.equal(parseCallTrace(largerPage.json()).nextOffset, null);
  assert.equal((await app.inject(`${traceRoute}?limit=301`)).statusCode, 400);
  const response = await app.inject(
    '/api/observation/experiments/run-alpha/calls/prompt-call/instructions',
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parseCallInstructions(response.json()), result);
  const child = await app.inject(
    '/api/observation/experiments/run-alpha/calls/prompt-call/instructions?runId=child',
  );
  assert.equal(child.statusCode, 200);
  const childInputs = parseCallInstructions(child.json());
  assert.equal(childInputs.submittedTask?.text, 'Check the baseline.');
  assert.equal(
    JSON.parse(childInputs.outputSchema?.text ?? 'null').type,
    'string',
  );
  assert.deepEqual(
    childInputs.workspaceInstructions,
    result.workspaceInstructions,
  );
  const withoutSubmission = await query.callInstructions(
    'run-alpha',
    'prompt-call',
    'child-without-task',
  );
  assert.equal(withoutSubmission.submittedTask, null);
  assert.equal(withoutSubmission.outputSchema, null);
  assert.equal(withoutSubmission.delegation, null);
  assert.equal(result.delegation, null);
  assert.equal(childInputs.delegation, null);

  const delegated = await app.inject(
    '/api/observation/experiments/run-alpha/calls/prompt-call/instructions?runId=delegated',
  );
  assert.equal(delegated.statusCode, 200);
  const delegatedInputs = parseCallInstructions(delegated.json());
  assert.equal(delegatedInputs.submittedTask, null);
  assert.deepEqual(delegatedInputs.delegation, {
    parentRunId: 'main',
    sequence: 3,
    message: {
      text: prompt.replace('secret-fixture', '[REDACTED]'),
      truncated: false,
    },
  });
  const lifecycleOnly = await query.callInstructions(
    'run-alpha',
    'prompt-call',
    'lifecycle-only',
  );
  assert.deepEqual(lifecycleOnly.delegation, {
    parentRunId: 'main',
    sequence: 5,
    message: null,
  });
  const recorded = await query.callInstructions(
    'run-alpha',
    'prompt-call',
    'recorded-delegation',
  );
  assert.deepEqual(recorded.delegation, {
    parentRunId: 'main',
    sequence: 6,
    message: {
      text: prompt.replace('secret-fixture', '[REDACTED]'),
      truncated: false,
    },
  });

  await assert.rejects(
    query.callInstructions('run-other', 'prompt-call'),
    /not found/,
  );
  await facts.write('calls', 'no-prompt', {
    experimentId: 'run-alpha',
    callId: 'no-prompt',
  });
  assert.equal(
    (await query.callInstructions('run-alpha', 'no-prompt')).submittedTask,
    null,
  );
  await facts.write('calls', 'large-prompt', {
    experimentId: 'run-alpha',
    callId: 'large-prompt',
  });
  const large = new FileAgentRecorder(
    join(directory, 'experiments', 'run-alpha', 'calls', 'large-prompt'),
  );
  large.record({
    runId: 'main',
    event: {
      type: 'task.submitted',
      text: 'p'.repeat(40000),
      outputSchema: {},
    },
  });
  await large.close();
  const bounded = await query.callInstructions('run-alpha', 'large-prompt');
  assert.equal(bounded.submittedTask?.text.length, 32768);
  assert.equal(bounded.submittedTask?.truncated, true);
});
