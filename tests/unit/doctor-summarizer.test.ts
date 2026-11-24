import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  type DoctorContext,
  type OperatorSummarizerInput,
} from '../../src/contracts/index.js';
import { operatorSummarizerDoctorRules } from '../../src/plugins/summarizer-operator/doctor.js';
import { operatorSummarizerDefinition } from '../../src/plugins/summarizer-operator/index.js';
import { createOperatorSummarizer } from '../../src/plugins/summarizer-operator/service.js';
import type { OperatorSummarizerConfig } from '../../src/plugins/summarizer-operator/schema.js';
import { diagnoseBinding } from '../../src/runtime/doctor/index.js';
import { Registry } from '../../src/runtime/registry/index.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'summarizer-doctor-'));
  const registry = new Registry();
  registry.registerOperation(operatorSummarizerDefinition);
  t.after(async () => {
    await registry.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  let agentCalls = 0;
  const runtime = new RuntimeContext().extend({
    directory,
    rootDirectory: directory,
    bindingId: 'summarizer',
    signal: new AbortController().signal,
    cleanup: new AbortController().signal,
    async invokeAgent(): Promise<never> {
      agentCalls++;
      assert.fail('Prompt checks must not invoke an Agent.');
    },
  });
  const config: OperatorSummarizerConfig = {
    agentRef: 'agent',
    promptFile: join(directory, 'summary.md'),
  };
  const binding = {
    name: 'summarizer',
    pluginId: 'summarizer.operator',
    config,
    definition: registry.get('summarizer.operator'),
  };
  const context: DoctorContext<OperatorSummarizerConfig> = {
    binding,
    recipe: { application: binding, bindings: {}, policyConfig: {} },
    registry,
    runtime,
    directory,
    signal: runtime.signal,
  };
  return { config, context, runtime, registry, agentCalls: () => agentCalls };
}

test('operator summarizer creates without reading its prompt and diagnoses missing, empty and valid contents', async (t) => {
  const { config, context, runtime, registry, agentCalls } = await fixture(t);
  const operation = await createOperatorSummarizer(config, runtime);
  t.after(() => operation.dispose());
  const rules = operatorSummarizerDoctorRules(context);
  assert.deepEqual(
    rules.map(({ id }) => id),
    ['prompt-content'],
  );
  for (const [content, status, error] of [
    [null, 'failed', /ENOENT/],
    [' \n\t', 'failed', /must not be empty/],
    ['Summarize confirmed evidence.\n', 'passed', null],
    [null, 'failed', /ENOENT/],
  ] as const) {
    if (content === null) await rm(config.promptFile, { force: true });
    else await writeFile(config.promptFile, content);
    const result = await diagnoseBinding(registry, context);
    assert.deepEqual(
      result.checks.map(({ id, status }) => [id, status]),
      [['prompt-content', status]],
    );
    if (error) {
      assert.match(result.checks[0]?.reason ?? '', /promptFile/);
      assert.match(result.checks[0]?.reason ?? '', error);
    }
  }
  assert.equal(agentCalls(), 0);
});

const summaryInput: OperatorSummarizerInput = {
  action: 'summarize',
  phase: 'static',
  entryCandidateRef: 'candidate',
  attempt: 1,
  analysisRef: 'analysis',
  historyRef: null,
  actions: [
    {
      action: 'propose',
      status: 'no-change',
      candidateRef: 'candidate',
      analysisRef: 'analysis',
      rationale: 'No supported change.',
      diffRef: null,
      reasonCode: 'no-supported-change',
    },
  ],
  candidateRefs: ['candidate'],
  measurementRefs: [],
  decisionRef: null,
  outcome: 'no-change',
};

test('operator summarizer rereads and rejects invalid prompts before executing an Agent request', async (t) => {
  const { config, runtime, agentCalls } = await fixture(t);
  await writeFile(config.promptFile, 'Summarize confirmed evidence.\n');
  const operation = await createOperatorSummarizer(config, runtime);
  t.after(() => operation.dispose());
  for (const content of [' \n', null]) {
    if (content === null) await rm(config.promptFile);
    else await writeFile(config.promptFile, content);
    await assert.rejects(
      operation.execute(summaryInput, runtime),
      content === null ? /ENOENT/ : /promptFile must not be empty/,
    );
  }
  assert.equal(agentCalls(), 0);
});
