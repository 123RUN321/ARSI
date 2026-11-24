import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorProbe } from '../../shared/doctor-check.js';
import { probeModelAccess } from './model-access.js';
import { resolveModelConfig } from './session.js';
import type { AgentPiConfig } from './schema.js';

export async function checkPiAgent(
  context: DoctorContext<AgentPiConfig>,
): Promise<DoctorResult> {
  const options = { signal: context.signal };
  const configuration = await runDoctorProbe(
    'model-config',
    async (signal) => resolveCheckedModel(context.binding.config, signal),
    options,
  );
  const model = configuration.value;
  if (!model) {
    return {
      checks: [
        configuration.check,
        {
          id: 'model-access',
          status: 'unchecked',
          reason:
            'Proposal model access was not checked because agent.pi model configuration is invalid.',
        },
      ],
    };
  }
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
    options,
  );
  return {
    checks: [
      configuration.check,
      access.value ? { id: access.check.id, ...access.value } : access.check,
    ],
  };
}

function resolveCheckedModel(
  config: AgentPiConfig,
  signal: AbortSignal,
): ReturnType<typeof resolveModelConfig> {
  signal.throwIfAborted();
  const resolved = resolveModelConfig(config);
  let url: URL;
  try {
    url = new URL(resolved.base_url);
  } catch {
    throw new Error('agent.pi base_url must resolve to an HTTP(S) endpoint');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'agent.pi base_url must resolve to a credential-free HTTP(S) endpoint',
    );
  }
  return resolved;
}
