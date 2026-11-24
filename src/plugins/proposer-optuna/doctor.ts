import type { DoctorContext, DoctorRule } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { parameterFileDoctorRules } from '../shared/parameter-editing/doctor.js';
import { parseOptunaConfig } from './schema.js';
import {
  runOptunaWorker,
  validateOptunaWorkerResponse,
  type OptunaWorker,
} from './worker.js';

export function optunaDoctorRules(
  context: DoctorContext,
  worker: OptunaWorker = runOptunaWorker,
): DoctorRule[] {
  context.signal.throwIfAborted();
  const config = parseOptunaConfig(context.binding.config);
  async function arePythonDependenciesAvailable(
    signal: AbortSignal,
  ): Promise<boolean> {
    const result = await worker(
      config,
      {
        action: 'check',
        sampler: object(config.sampler),
        constraintHandling: config.constraintHandling,
        searchSpace: config.searchSpace,
        history: [],
      },
      signal,
    );
    validateOptunaWorkerResponse(result, 'check');
    return true;
  }
  return [
    ...parameterFileDoctorRules(context),
    {
      id: 'python-dependencies',
      check: arePythonDependenciesAvailable,
      reason:
        'Install the required Python, Optuna and NumPy versions in the configured Python environment.',
    },
  ];
}
