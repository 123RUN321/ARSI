import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HarnessResultsView } from '../../web/features/experiments/harness-results.js';

function measurement(ref, value, status = 'succeeded') {
  return {
    ref,
    candidateRef: `candidate-${ref}`,
    callId: `call-${ref}`,
    status,
    coverage: 'complete',
    comparisonKey: 'same-task',
    startedAt: null,
    finishedAt: null,
    metrics: [
      {
        name: 'meanReward',
        unit: 'score',
        status: 'available',
        values: { value },
        description: '',
        definitionRef: 'score-definition',
        reason: null,
      },
    ],
  };
}
function render(records, references) {
  return renderToStaticMarkup(
    createElement(HarnessResultsView, {
      id: 'experiment',
      measurements: records,
      references,
      labels: {
        harness: (ref) => ({
          round: 'Round 1',
          variant: ref === 'base' ? 'Base' : 'Composed',
        }),
        task: () => 'terminal-bench/example',
      },
    }),
  );
}
const selection = [
  {
    kind: 'measurement',
    ref: 'selected',
    path: '/deliveries/0/measurementRef',
  },
];

test('Harness delivered column follows the saved selection even when another attempt scores higher', () => {
  const html = render(
    [
      measurement('base', 1),
      measurement('selected', 0),
      measurement('later', 0.9),
    ],
    selection,
  );
  assert.match(html, />Delivered</);
  assert.match(html, /aria-label="Delivered · Composed · 0"/);
  assert.match(html, /measurement=selected/);
  assert.doesNotMatch(html, /aria-label="Delivered · [^"]*0\.9/);
  assert.match(html, /terminal-bench\/example/);
});

test('Harness never invents a delivery for pending or missing selection evidence', () => {
  const records = [measurement('base', 1)];
  assert.match(render(records, []), /Not recorded/);
  const missing = render(records, selection);
  assert.match(missing, /Not recorded/);
  assert.match(missing, /Some returned evaluations are unavailable/);
  assert.doesNotMatch(missing, /aria-label="Delivered ·/);
});

test('failed delivered measurements retain their evidence and status without contributing a numeric score', () => {
  const html = render(
    [
      measurement('base', 1),
      { ...measurement('selected', 0.8, 'failed'), coverage: 'partial' },
    ],
    selection,
  );
  assert.match(html, /aria-label="Delivered · Composed · Score unavailable"/);
  assert.match(html, /failed/);
  assert.match(html, /partial/);
  assert.match(html, /Average score · 0\/1 rounds/);
});
