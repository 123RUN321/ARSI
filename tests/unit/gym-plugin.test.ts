import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { validate } from '../../src/shared/schema.js';
import { gymDefinition } from '../../src/plugins/evaluator-gym/index.js';
import {
  gymPluginConfigSchema,
  type GymPluginConfig,
} from '../../src/plugins/evaluator-gym/schema.js';
import { createGymOperation } from '../../src/plugins/evaluator-gym/service.js';

const evaluateConfig: GymPluginConfig = {
  mode: 'evaluate',
  baseUrl: 'http://127.0.0.1:8411',
  requestDefaults: {
    adapter: 'dsh_candidate',
    benchmark: 'gaia_text_validation',
    split: 'train_full',
    tier: 'full',
    seed: 48,
  },
};

const promoteConfig: GymPluginConfig = {
  mode: 'promote',
  baseUrl: 'http://127.0.0.1:8411',
  promotionDefaults: {
    adapter: 'dsh_candidate',
    benchmark: 'gaia_text_validation',
    seed: 48,
  },
};

test('gym plugin rejects actions outside its binding mode before external calls', async () => {
  const context = new RuntimeContext().extend({
    signal: new AbortController().signal,
  });
  const evaluate = await createGymOperation(evaluateConfig, context);
  const promote = await createGymOperation(promoteConfig, context);

  await assert.rejects(
    evaluate.execute(
      {
        action: 'promote',
        candidateRef: 'candidate:final',
        incumbentRef: 'candidate:initial',
      },
      context,
    ),
    /evaluate-only; rejected action promote/,
  );
  await assert.rejects(
    promote.execute(
      {
        action: 'evaluate',
        candidateRef: 'candidate:final',
        taskIds: ['task/a'],
      },
      context,
    ),
    /promote-only; rejected action evaluate/,
  );
  await evaluate.dispose();
  await promote.dispose();
});

test('gym plugin configuration requires an explicit mode', () => {
  const invalid: JsonObject = {
    baseUrl: 'http://127.0.0.1:8411',
    requestDefaults: {
      adapter: 'dsh_candidate',
      benchmark: 'gaia_text_validation',
      split: 'train_full',
      tier: 'full',
      seed: 48,
    },
  };
  assert.throws(
    () => validate(gymPluginConfigSchema, invalid, 'gym plugin config'),
    /must have required property 'mode'/,
  );
  assert.equal(gymDefinition.id, 'evaluator.gym');
  assert.equal(gymDefinition.contract.id, 'contract.gym');
});
