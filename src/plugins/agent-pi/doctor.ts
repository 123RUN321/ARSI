import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { failed, passed, runDoctorProbe } from '../../shared/doctor-check.js';
import { errorText } from '../../shared/errors.js';
import { isHttpUrl } from '../shared/doctor/checks.js';
import { probeModelAccess } from './model-access.js';
import { resolveModelConfig } from './session.js';
import type { AgentPiConfig } from './schema.js';

export async function checkPiAgent(
  context: DoctorContext<AgentPiConfig>,
): Promise<DoctorResult> {
  const config = context.binding.config;
  let model: ReturnType<typeof resolveModelConfig>;
  try {
    model = resolveModelConfig(config);
  } catch (error) {
    context.signal.throwIfAborted();
    return failed(
      'model-config',
      `Correct model, base_url or api_key and their environment variables. ${errorText(error)}`,
    );
  }
  if (!isHttpUrl(model.base_url))
    return failed(
      'model-config',
      'agent.pi base_url must resolve to a credential-free HTTP(S) endpoint. Correct base_url or its environment variable.',
    );

  const access = await runDoctorProbe(
    'model-access',
    (signal) =>
      probeModelAccess(
        {
          side: 'Proposal',
          model: model.model,
          baseUrl: model.base_url,
          apiKey: model.api_key,
        },
        signal,
      ),
    { signal: context.signal },
  );
  if (!access.value)
    return failed(access.check.id, access.check.reason, access.check.details);
  if (access.value.status === 'failed')
    return failed('model-access', access.value.reason, access.value.details);
  return passed('model-access', access.value.reason, access.value.details);
}
