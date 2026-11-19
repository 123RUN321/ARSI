import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { JsonObject } from '../../src/contracts/index.js';
import { operatorProposerContract } from '../../src/contracts/plugin-types/proposer-operator.js';
import { operatorEditOutputSchema } from '../../src/plugins/proposer-operator/schema.js';
import { parseMetricsDiagnosis as parse } from '../../src/plugins/shared/operator-attempt/service.js';
import { metricEvidenceGuide } from '../../src/plugins/shared/operator-attempt/metric-evidence.js';
import { validate } from '../../src/shared/schema.js';
import { summaryResponseSchema } from '../../src/plugins/shared/operator-attempt/schema.js';

test('metrics proposal contract requires current evidence and a positive round', () => {
  const input = {
    action: 'propose',
    phase: 'metrics',
    parentCandidateRef: 'parent',
    incumbentMeasurementRef: 'assessment',
    diagnosticMeasurementRef: 'profile',
    round: 11,
    historyRef: 'history',
    staticHistoryRef: null,
    goal: 'Optimize the measured bottleneck',
  };
  assert.doesNotThrow(() =>
    validate(operatorProposerContract.input_schema, input),
  );
  assert.throws(() =>
    validate(operatorProposerContract.input_schema, { ...input, round: 0 }),
  );
  assert.throws(() =>
    validate(operatorProposerContract.input_schema, {
      ...input,
      diagnosticMeasurementRef: null,
    }),
  );
});

test('invalid model output is an explicit business failure with retained analysis and error evidence', () => {
  assert.doesNotThrow(() =>
    validate(operatorProposerContract.output_schema, {
      action: 'propose',
      status: 'failed',
      candidateRef: 'parent',
      diffRef: null,
      analysisRef: 'draft',
      errorRef: 'error',
      rationale: 'Invalid JSON',
      reasonCode: 'invalid-model-output',
    }),
  );
});

test('metric analysis requires measured numeric evidence and keeps model inference distinct', async () => {
  const profile = { kernels: [{ metrics: { '0': { aiv_vec_ratio: 0.8 } } }] };
  const reply = {
    status: 'hypothesis',
    category: 'vector',
    summary: 'Vector pipe is busy',
    reasoning: 'Optimize the vector work',
    rootCause: 'A hypothesis about the reduction',
    recommendedFix: 'Reduce scalar overhead',
    evidence: [{ path: '/kernels/0/metrics/0/aiv_vec_ratio', value: 0.8 }],
  };
  assert.deepEqual(parse(reply, profile), reply);
  assert.throws(
    () =>
      parse(
        {
          ...reply,
          evidence: [
            { path: '/kernels/0/metrics/0/aiv_vec_ratio', value: 0.9 },
          ],
        },
        profile,
      ),
    /evidence/i,
  );
  assert.throws(
    () =>
      parse(
        { ...reply, evidence: [{ path: '/metadata/ub_ratio', value: 0.5 }] },
        profile,
      ),
    /evidence/i,
  );
});

test('operator edits accept complete source only at the literal Target path', () => {
  const sourcePath = 'kernels/transpose[0].py';
  const schema = operatorEditOutputSchema([sourcePath]);
  assert.doesNotThrow(() =>
    validate(schema, {
      edits: [{ path: sourcePath, content: '\u20ac'.repeat(12000) }],
      reason: 'Complete source subject to the Application Target',
    }),
  );
  for (const path of ['input.py', 'kernels/transpose0.py', 'context/source.py'])
    assert.throws(() =>
      validate(schema, {
        edits: [{ path, content: 'invalid replacement' }],
        reason: 'Outside the Target',
      }),
    );
});

test('metric diagnosis distinguishes an unsupported search direction from an invalid diagnosis', () => {
  const reply = {
    status: 'no-new-hypothesis',
    reason: 'All supported distinct edits have been considered',
  };
  assert.deepEqual(parse(reply, {}), reply);
  for (const invalid of [
    { status: 'no-new-hypothesis', reason: '' },
    { ...reply, recommendedFix: 'Invent another fix' },
    { status: 'hypothesis', reason: 'No metric citations' },
  ])
    assert.throws(() => parse(invalid, {}));
  const output = {
    action: 'propose',
    status: 'no-change',
    candidateRef: 'parent',
    analysisRef: 'analysis',
    rationale: reply.reason,
    diffRef: null,
    reasonCode: 'no-new-hypothesis',
  };
  validate(operatorProposerContract.output_schema, output);
  assert.throws(() =>
    validate(operatorProposerContract.output_schema, {
      ...output,
      action: 'repair',
    }),
  );
});

test('packaged and example summary JSON examples satisfy the model response contract', async () => {
  for (const path of [
    'src/policies/operator-search/prompts/summarize.md',
    'examples/artifacts/kernel/transpose-copy/prompts/summarize.md',
  ]) {
    const prompt = await readFile(path, 'utf8');
    const example = prompt.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(example, path);
    validate(summaryResponseSchema, JSON.parse(example[1]), path);
  }
});

test('diagnosis guide cites a measured value accepted by the evidence checker', () => {
  const profile: JsonObject = {
    kernels: [
      { metrics: {} },
      { metrics: { 'a/b': { ub_ratio: 1, label: 'x', 'bw~/s': 0 } } },
    ],
  };
  const example = { path: '/kernels/1/metrics/a~1b/bw~0~1s', value: 0 };
  assert.deepEqual(metricEvidenceGuide(profile).example, example);
  assert.equal(metricEvidenceGuide({ kernels: [] }).example, undefined);
  const diagnosis = {
    status: 'hypothesis',
    category: 'vector',
    summary: 'Review bandwidth',
    reasoning: 'The observed counter warrants investigation',
    rootCause: 'Uncertain',
    recommendedFix: 'Review tiling',
    evidence: [example],
  };
  assert.deepEqual(parse(diagnosis, profile), diagnosis);
  for (const path of [example.path + '/', '/kernels/1/metrics/bw~0~1s'])
    assert.throws(() =>
      parse({ ...diagnosis, evidence: [{ path, value: 0 }] }, profile),
    );
});
