import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { missingInputError, passed } from '../../../shared/doctor-check.js';
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

export function checkOperationConfiguration(): DoctorResult {
  return passed('configuration');
}

export async function requireReadablePath(
  path: string,
  field: string,
  kind: 'file' | 'directory',
): Promise<void> {
  try {
    const stat = await lstat(path);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
      throw new Error(`Expected a regular ${kind}: ${path}`);
    await access(path, constants.R_OK);
  } catch (error) {
    if (missingPath(error))
      throw missingInputError({ field, kind, reference: path }, error);
    throw new Error(
      `Correct ${field} to point to a readable ${kind}: ${path}.`,
      { cause: error },
    );
  }
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
