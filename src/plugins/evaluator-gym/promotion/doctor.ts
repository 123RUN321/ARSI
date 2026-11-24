import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import { failed, passed } from '../../../shared/doctor-check.js';
import { errorText } from '../../../shared/errors.js';
import { isHttpUrl } from '../../shared/doctor/checks.js';
import type { GymPromotionConfig } from './schema.js';
import { resolvePromotionConfig } from './service.js';

export function gymPromotionDoctor(
  context: DoctorContext<GymPromotionConfig>,
): DoctorResult {
  let config: GymPromotionConfig;
  try {
    config = resolvePromotionConfig(context.binding.config);
  } catch (error) {
    context.signal.throwIfAborted();
    return failed(
      'configuration',
      `Correct baseUrl and its environment variable. ${errorText(error)}`,
    );
  }
  if (!isHttpUrl(config.baseUrl))
    return failed(
      'configuration',
      'Set baseUrl to a valid URL using HTTP(S) without embedded credentials, or correct the environment variable it references.',
    );
  return {
    checks: [
      ...passed('configuration').checks,
      {
        id: 'holdout-service',
        status: 'unchecked',
        reason:
          'Doctor does not contact Gym or execute holdout; the configured profile must register the requested benchmark and adapter before release.',
      },
    ],
  };
}
