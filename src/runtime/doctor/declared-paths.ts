import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type {
  DoctorBinding,
  DoctorResult,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import {
  DoctorMissingResourceError,
  runDoctorCheck,
} from '../../shared/doctor-check.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';

function readConfigValue(config: JsonObject, pointer: string): JsonValue {
  let value: JsonValue = config;
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object')
      throw new Error(`Invalid resolved path ${pointer}`);
    value = Array.isArray(value) ? value[Number(key)] : value[key];
  }
  return value;
}

export async function* checkDeclaredPaths(
  binding: DoctorBinding,
  signal: AbortSignal,
): AsyncGenerator<DoctorResult['checks'][number]> {
  for (const { pointer, kind } of configPathFields(
    binding.definition.configSchema,
    binding.config,
  )) {
    const reference = readConfigValue(binding.config, pointer);
    if (typeof reference !== 'string' || isResourceUrl(reference)) continue;
    const configField = pointer.slice(1).replaceAll('/', '.');
    yield runDoctorCheck(
      `resource.${configField}`,
      async () => {
        try {
          const pathInfo = await stat(reference);
          if (!(kind === 'file' ? pathInfo.isFile() : pathInfo.isDirectory()))
            throw new Error(`${pointer}: expected ${kind}: ${reference}`);
          await access(reference, constants.R_OK);
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            throw new DoctorMissingResourceError(
              { field: configField, kind, reference },
              error,
            );
          throw error;
        }
      },
      { signal },
    );
  }
}
