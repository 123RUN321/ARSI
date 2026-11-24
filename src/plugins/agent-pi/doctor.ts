import type { DoctorContext, DoctorStep } from '../../contracts/index.js';
import { isHttpUrl } from '../shared/doctor/checks.js';
import { probeModelAccess, type ModelAccessResult } from './model-access.js';
import { resolveModelConfig } from './session.js';
import type { AgentPiConfig } from './schema.js';

export function checkPiAgent(
  context: DoctorContext<AgentPiConfig>,
): DoctorStep[] {
  context.signal.throwIfAborted();
  let model: ReturnType<typeof resolveModelConfig>;
  let access: ModelAccessResult | undefined;
  function isModelConfigurationValid(signal: AbortSignal): boolean {
    signal.throwIfAborted();
    model = resolveModelConfig(context.binding.config);
    return isHttpUrl(model.base_url);
  }
  async function isModelAccessible(signal: AbortSignal): Promise<boolean> {
    access = await probeModelAccess(
      {
        side: 'Proposal',
        model: model.model,
        baseUrl: model.base_url,
        apiKey: model.api_key,
      },
      signal,
    );
    return access.status === 'passed';
  }
  return [
    {
      id: 'model-config',
      check: isModelConfigurationValid,
      reason:
        'Correct model, base_url or api_key and their environment variables; base_url must resolve to a credential-free HTTP(S) endpoint.',
    },
    {
      id: 'model-access',
      check: isModelAccessible,
      get reason() {
        return (
          access?.reason ??
          'Check the configured model service and access credentials.'
        );
      },
      get details() {
        return access
          ? { ...access.details, observation: access.reason }
          : undefined;
      },
    },
  ];
}
