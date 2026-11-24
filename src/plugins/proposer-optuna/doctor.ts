import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { failed, passed, runDoctorCheck } from '../../shared/doctor-check.js';
import { object } from '../../shared/json.js';
import { parseOptunaConfig } from './schema.js';
import {
  runOptunaWorker,
  validateOptunaWorkerResponse,
  type OptunaWorker,
} from './worker.js';

export async function checkOptunaDependencies(
  context: DoctorContext,
  worker: OptunaWorker = runOptunaWorker,
): Promise<DoctorResult> {
  context.signal.throwIfAborted();
  const config = parseOptunaConfig(context.binding.config);
  const dependencies = await runDoctorCheck(
    'python-dependencies',
    async (signal) => {
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
    },
    { signal: context.signal },
  );
  if (dependencies.status === 'failed')
    return failed(dependencies.id, dependencies.reason, dependencies.details);
  return passed('python-dependencies');
}
