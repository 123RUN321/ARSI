import type { DoctorContext, DoctorStep } from '../../../contracts/index.js';
import { isHttpUrl } from '../../shared/doctor/checks.js';
import type { GymConfig } from './schema.js';
import { resolveGymConfig } from './service.js';

export function gymDoctor(context: DoctorContext<GymConfig>): DoctorStep[] {
  context.signal.throwIfAborted();
  function isConfigurationValid(signal: AbortSignal): boolean {
    signal.throwIfAborted();
    return isHttpUrl(resolveGymConfig(context.binding.config).baseUrl);
  }
  return [
    {
      id: 'configuration',
      check: isConfigurationValid,
      reason:
        'Set baseUrl to a valid URL using HTTP(S) without embedded credentials, or correct the environment variable it references.',
    },
    {
      id: 'eval-service',
      reason:
        'Doctor does not contact Gym; start the Gym environment and wait for its adapters before submitting evaluations.',
    },
  ];
}
