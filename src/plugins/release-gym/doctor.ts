import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import type { GymReleaseConfig } from './schema.js';
import { resolveReleaseConfig } from './service.js';

export async function gymReleaseDoctor(
  context: DoctorContext<GymReleaseConfig>,
): Promise<DoctorResult> {
  const configuration = await runDoctorCheck(
    'configuration',
    async (signal) => {
      signal.throwIfAborted();
      const config = resolveReleaseConfig(context.binding.config);
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
