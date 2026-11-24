import type { DoctorContext, DoctorRule } from '../../../contracts/index.js';
import { isHttpUrl } from '../../shared/doctor/checks.js';
import type { GymPromotionConfig } from './schema.js';
import { resolvePromotionConfig } from './service.js';

export function gymPromotionDoctor(
  context: DoctorContext<GymPromotionConfig>,
): DoctorRule[] {
  context.signal.throwIfAborted();
  function isConfigurationValid(signal: AbortSignal): boolean {
    signal.throwIfAborted();
    return isHttpUrl(resolvePromotionConfig(context.binding.config).baseUrl);
  }
  return [
    {
      id: 'configuration',
      check: isConfigurationValid,
      reason:
        'Set baseUrl to a valid URL using HTTP(S) without embedded credentials, or correct the environment variable it references.',
    },
    {
      id: 'holdout-service',
      reason:
        'Doctor does not contact Gym or execute holdout; the configured profile must register the requested benchmark and adapter before release.',
    },
  ];
}
