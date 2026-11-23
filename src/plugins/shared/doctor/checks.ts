import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import { agentContract } from '../../../contracts/plugin-types/agent.js';

export function resolveAgent(context: DoctorContext, reference: string): void {
  const binding = context.recipe.bindings[reference];
  if (!binding)
    throw new Error(`agentRef: Agent binding ${reference} is not declared`);
  context.registry.assertContract(agentContract, binding.pluginId, reference);
}

export function missingPath(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (
    'code' in error &&
    error.code === 'ENOENT' &&
    'path' in error &&
    typeof error.path === 'string'
  )
    return error.path;
  return missingPath(error.cause);
}

/** Reaching this handler confirms the factory accepted the effective configuration. */
export function checkOperationConfiguration(): DoctorResult {
  return { checks: [{ id: 'configuration', status: 'passed' }] };
}
