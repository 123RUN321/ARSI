import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import { runDoctorCheck } from '../../../shared/doctor-check.js';
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
      if (!URL.canParse(config.baseUrl))
        throw new Error(
          'Set baseUrl to a valid URL or correct the environment variable it references.',
        );
    },
    { signal: context.signal },
  );
  return {
    checks: [
      configuration,
      {
        id: 'eval-service',
        status: 'unchecked',
        ...(configuration.status === 'failed'
          ? { blockedBy: configuration.id }
          : {}),
        reason:
          'Doctor does not contact Gym; start the Gym environment and wait for its adapters before submitting evaluations.',
      },
    ],
  };
}
