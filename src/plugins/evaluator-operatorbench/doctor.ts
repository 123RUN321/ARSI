import { join } from 'node:path';
import type { DoctorContext, OperationDoctor } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import type { SdkEvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';
import { checkSdkDoctor } from '../shared/evaluator-adapter/doctor.js';
import type { SdkDoctorRunner } from '../shared/evaluator-adapter/doctor-sdk.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import { prepareEvaluationConfig } from './service.js';

async function prepareOperatorbenchConfig(
  context: DoctorContext,
  env: NodeJS.ProcessEnv,
): Promise<SdkEvaluatorConfig> {
  const directory = string(
    object(context.binding.config.task, 'task').directory,
    'task.directory',
  );
  const task = await loadOperatorTask(directory);
  const config = prepareEvaluationConfig(context.binding.config, {
    selected: task.cases[0]!,
    operation: 'evaluate',
    directory: context.directory,
    manifest: join(context.directory, 'manifest.json'),
  });
  env.RSI_KERNEL_REPLAY_NO_MODEL_KEY = 'not-a-secret-no-model-calls';
  return config;
}

export function createOperatorbenchDoctor(
  run?: SdkDoctorRunner,
): OperationDoctor {
  return (context) => checkSdkDoctor(context, prepareOperatorbenchConfig, run);
}

export const operatorbenchDoctor = createOperatorbenchDoctor();
