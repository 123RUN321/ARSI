import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import type { GymConfig } from './schema.js';
import { resolveGymConfig } from './service.js';

export async function gymDoctor(
  context: DoctorContext<GymConfig>,
): Promise<DoctorResult> {
  const configuration = await runDoctorCheck(
    'configuration',
    async (signal) => {
      signal.throwIfAborted();
      const config = resolveGymConfig(context.binding.config);
      new URL(config.baseUrl);
    },
    {
      signal: context.signal,
      reason:
        'Gym evaluator configuration resolves and its eval_service URL is valid.',
    },
  );
  return {
    checks: [
      configuration,
      {
        id: 'eval-service',
        status: 'unchecked',
        reason:
          'Doctor does not contact Gym; start the Gym environment and wait for its adapters before submitting evaluations.',
      },
    ],
  };
}
