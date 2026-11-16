import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatorScheduling } from '../../src/plugins/shared/evaluator-adapter/scheduling.js';

test('scheduling overrides are opt-in and require both limits and an audit reason', () => {
  assert.equal(evaluatorScheduling({}), undefined);
  assert.deepEqual(
    evaluatorScheduling({
      RSI_EVALUATOR_CONCURRENCY: '16',
      RSI_EVALUATOR_PREPARATION_CONCURRENCY: '16',
      RSI_EVALUATOR_SCHEDULING_REASON: 'approved continuation',
    }),
    {
      concurrency: 16,
      preparationConcurrency: 16,
      reason: 'approved continuation',
    },
  );
  assert.throws(() => evaluatorScheduling({ RSI_EVALUATOR_CONCURRENCY: '16' }));
});

for (const value of ['0', '-1', '1.5', '16x', '9007199254740992'])
  test(`rejects invalid scheduling concurrency ${value}`, () => {
    const valid = {
      RSI_EVALUATOR_CONCURRENCY: '16',
      RSI_EVALUATOR_PREPARATION_CONCURRENCY: '16',
      RSI_EVALUATOR_SCHEDULING_REASON: 'operator',
    };
    assert.throws(() =>
      evaluatorScheduling({ ...valid, RSI_EVALUATOR_CONCURRENCY: value }),
    );
    assert.throws(() =>
      evaluatorScheduling({
        ...valid,
        RSI_EVALUATOR_PREPARATION_CONCURRENCY: value,
      }),
    );
  });
