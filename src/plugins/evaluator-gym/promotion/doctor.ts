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
      new URL(config.baseUrl);
    },
    {
      signal: context.signal,
      reason:
        'Gym release configuration resolves and its eval_service URL is valid.',
    },
  );
  return {
    checks: [
      configuration,
      {
        id: 'holdout-service',
        status: 'unchecked',
        reason:
          'Doctor does not contact Gym or execute holdout; the configured profile must register the requested benchmark and adapter before release.',
      },
    ],
  };
}
