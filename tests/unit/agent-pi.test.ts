import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentPi,
  resolveModelConfig,
} from '../../src/plugins/agent-pi/service.js';
import { configSchema } from '../../src/plugins/agent-pi/schema.js';
import { validate } from '../../src/shared/schema.js';
import { agentFixture } from '../fixtures/agent-execution.js';

test('Pi stays in process and reports invalid model configuration without launching a CLI', async (t) => {
  const f = await agentFixture(async () => {
    assert.fail('Pi must not launch a worker or CLI');
  });
  t.after(() => f.close());
  const agent = await createAgentPi(
    { model: '${RSI_PI_FIXTURE_MISSING_MODEL}' },
    f.context,
  );
  await assert.rejects(f.execute(agent), /missing environment variable/);
});

test('Pi resolves explicit model environment references and rejects removed unrestricted bash config', async (t) => {
  assert.deepEqual(
    resolveModelConfig(
      {},
      {
        MODEL_NAME: 'model',
        MODEL_ENDPOINT: 'http://localhost/v1',
        MODEL_API_KEY: 'key',
      },
    ),
    { model: 'model', base_url: 'http://localhost/v1', api_key: 'key' },
  );
  const f = await agentFixture();
  t.after(() => f.close());
  assert.throws(
    () => validate(configSchema, { bashMode: 'direct' }),
    /additional properties/,
  );
});
