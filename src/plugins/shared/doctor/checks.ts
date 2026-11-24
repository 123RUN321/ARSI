import { passed } from '../../../shared/doctor-check.js';
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
  return passed('configuration');
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
