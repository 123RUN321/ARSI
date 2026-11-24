import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import { runDoctorCheck } from '../../../shared/doctor-check.js';
import type { GymPromotionConfig } from './schema.js';
import { resolvePromotionConfig } from './service.js';

export async function gymPromotionDoctor(
  context: DoctorContext<GymPromotionConfig>,
): Promise<DoctorResult> {
  const configuration = await runDoctorCheck(
    'configuration',
    async (signal) => {
      signal.throwIfAborted();
      const config = resolvePromotionConfig(context.binding.config);
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
        id: 'holdout-service',
        status: 'unchecked',
        reason:
          configuration.status === 'failed'
            ? 'Gym configuration failed validation. Correct baseUrl before using Gym.'
            : 'Doctor does not contact Gym or execute holdout; the configured profile must register the requested benchmark and adapter before release.',
      },
    ],
  };
}
