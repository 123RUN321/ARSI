import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import { failed, passed } from '../../../shared/doctor-check.js';
import { errorText } from '../../../shared/errors.js';
import { isHttpUrl } from '../../shared/doctor/checks.js';
import type { GymConfig } from './schema.js';
import { resolveGymConfig } from './service.js';

export function gymDoctor(context: DoctorContext<GymConfig>): DoctorResult {
  context.signal.throwIfAborted();
  let config: GymConfig;
  try {
    config = resolveGymConfig(context.binding.config);
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
        id: 'eval-service',
        status: 'unchecked',
        reason:
          'Doctor does not contact Gym; start the Gym environment and wait for its adapters before submitting evaluations.',
      },
    ],
  };
}
