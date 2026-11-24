import type { DoctorResult } from '../../../contracts/index.js';

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
