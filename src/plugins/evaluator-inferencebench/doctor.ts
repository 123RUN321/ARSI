import type { DoctorContext, OperationDoctor } from '../../contracts/index.js';
import { string } from '../../shared/json.js';
import type { SdkEvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import { checkSdkDoctor } from '../shared/evaluator-adapter/doctor.js';
import type { SdkDoctorRunner } from '../shared/evaluator-adapter/doctor-sdk.js';
import { prepareEvaluationConfig } from './service.js';

function prepareInferencebenchConfig(
  context: DoctorContext,
): SdkEvaluatorConfig {
  if (
    ['application.agentbundle', 'application.kernel'].includes(
      context.recipe.application.pluginId,
    )
  )
    throw new Error(
      'evaluator.inferencebench requires an Application with the inference-endpoint capability.',
    );
  const endpoint = plain(context.recipe.application.config.endpoint);
  const credentials = plain(context.recipe.application.config.credentials);
  return prepareEvaluationConfig(context.binding.config, {
    execution: {
      model: string(endpoint.model, 'application.config.endpoint.model'),
      baseUrl: 'http://127.0.0.1:1',
      ...(typeof credentials.apiKeyEnv === 'string'
        ? { credentialRef: credentials.apiKeyEnv }
        : {}),
    },
    directory: context.directory,
  });
}

export function createInferencebenchDoctor(
  run?: SdkDoctorRunner,
): OperationDoctor {
  return async (context) => {
    const { checks } = await checkSdkDoctor(
      context,
      prepareInferencebenchConfig,
      run,
    );
    if (checks.some((check) => check.status === 'failed')) return { checks };
    return {
      checks: [
        ...checks,
        {
          id: 'inference-endpoint',
          status: 'unchecked',
          reason:
            'The Application creates the endpoint during execution; SDK doctor used a placeholder without establishing service readiness.',
        },
      ],
    };
  };
}

export const inferencebenchDoctor = createInferencebenchDoctor();
