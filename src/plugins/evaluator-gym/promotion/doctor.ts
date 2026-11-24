import type { DoctorContext, DoctorStep } from '../../../contracts/index.js';
import { isHttpUrl } from '../../shared/doctor/checks.js';
import type { GymPromotionConfig } from './schema.js';
import { resolvePromotionConfig } from './service.js';

export function gymPromotionDoctor(
  context: DoctorContext<GymPromotionConfig>,
): DoctorStep[] {
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
