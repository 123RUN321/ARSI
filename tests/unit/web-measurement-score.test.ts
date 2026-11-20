import test from 'node:test';
import assert from 'node:assert/strict';
import {
  primaryMetric,
  primaryScore,
  roundAverage,
  metricValue,
} from '../../web/features/experiments/measurement-score.js';
import {
  parseExperiment,
  type MeasurementSummary,
} from '../../web/api/observation-client.js';
import { comparisonPolicy } from '../../web/features/experiments/policy-presentation.js';

test('primary score prefers the aggregate score and preserves zero and missing values', () => {
  const measurement: MeasurementSummary = {
    ref: 'm',
    candidateRef: 'c',
    callId: 'call',
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: null,
    startedAt: null,
    finishedAt: null,
    metrics: [
      {
        name: 'meanReward',
        unit: 'score',
        status: 'available',
        values: { value: 0 },
        description: '',
        definitionRef: 'artifact-score-definition',
        reason: null,
      },
    ],
  };
  assert.equal(primaryScore(measurement), 0);
  const score = {
    ...measurement.metrics[0]!,
    name: 'score',
    unit: 'native',
    values: { value: 0.75 },
  };
  const withBoth = { ...measurement, metrics: [...measurement.metrics, score] };
  assert.equal(primaryScore(withBoth), 0.75);
  assert.equal(roundAverage([[measurement], [withBoth]]), 0.75);
  assert.equal(
    primaryMetric([
      { ...score, status: 'unavailable', values: {} },
      ...measurement.metrics,
    ])?.name,
    'meanReward',
  );
  assert.equal(metricValue(measurement, measurement.metrics[0]!), 0);
  for (const status of ['failed', 'unknown', 'cancelled']) {
    assert.equal(
      metricValue({ ...measurement, status }, measurement.metrics[0]!),
      null,
      `${status} evaluations must not supply a result score`,
    );
  }
  const withScore = (value: number): MeasurementSummary => ({
    ...measurement,
    metrics: [{ ...measurement.metrics[0]!, values: { value } }],
  });
  assert.equal(
    roundAverage([[withScore(0), withScore(1)], [withScore(1)]]),
    0.75,
  );
  assert.equal(roundAverage([[], [withScore(0)]]), 0);
  assert.equal(roundAverage([[]]), null);
  assert.equal(primaryScore({ ...measurement, metrics: [] }), null);
  assert.equal(
    primaryScore({
      ...measurement,
      metrics: [{ ...measurement.metrics[0]!, values: { value: null } }],
    }),
    null,
  );
});

test('Harness comparison reads current and historical Recipe policy identifiers', () => {
  const config = { dataset: { taskIds: ['office-task'] } };
  const preview = (policy: object) => ({
    text: JSON.stringify({ policy }),
    truncated: false,
  });
  for (const policy of [
    { id: 'policy.harness2', config },
    { ref: 'policy.harness2', config },
  ]) {
    assert.deepEqual(comparisonPolicy(preview(policy)), {
      taskIds: ['office-task'],
    });
  }
  assert.equal(comparisonPolicy(preview({ id: 'policy.gepa', config })), null);
});

test('experiment summaries accept an omitted policy reference from older servers', () => {
  const summary = {
    id: 'experiment',
    recipeId: 'recipe',
    status: 'succeeded',
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  assert.equal(parseExperiment(summary).policyRef, null);
  assert.equal(
    parseExperiment({ ...summary, policyRef: 'policy.harness2' }).policyRef,
    'policy.harness2',
  );
  assert.throws(
    () => parseExperiment({ ...summary, policyRef: 42 }),
    /Invalid text/,
  );
});
