import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { parse, sep } from 'node:path';
import type { DoctorBinding, DoctorResult } from '../../contracts/index.js';
import {
  missingInputError,
  runDoctorCheck,
} from '../../shared/doctor-check.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';

const directorySuffix = sep === '\\' ? /(?:[\\/]\.?)+$/ : /(?:\/\.?)+$/;

export async function* checkDeclaredPaths(
  binding: DoctorBinding,
  signal: AbortSignal,
): AsyncGenerator<DoctorResult['checks'][number]> {
  for (const { pointer, kind, reference, localOnly } of configPathFields(
    binding.definition.configSchema,
    binding.config,
  )) {
    const isUrl = isResourceUrl(reference);
    if (isUrl && !localOnly) continue;
    const configField = pointer.slice(1).replaceAll('/', '.');
    const field = `${binding.name}.config.${configField}`;
    yield runDoctorCheck(
      `resource.${configField}`,
      async () => {
        if (isUrl)
          throw new Error(
            `Set ${field} to a local ${kind} path. Current value is ${reference}.`,
          );
        let path = reference;
        if (localOnly && kind === 'directory') {
          // A trailing slash or dot can make lstat follow the final symlink.
          const { root } = parse(reference);
          path =
            root + reference.slice(root.length).replace(directorySuffix, '');
        }
        try {
          const pathInfo = await (localOnly ? lstat(path) : stat(path));
          if (pathInfo.isSymbolicLink())
            throw new Error(
              `${configField}: symbolic links are not allowed: ${reference}`,
            );
          if (!(kind === 'file' ? pathInfo.isFile() : pathInfo.isDirectory()))
            throw new Error(`${pointer}: expected ${kind}: ${reference}`);
          await access(reference, constants.R_OK);
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            throw missingInputError({ field, kind, reference }, error);
          throw new Error(`Correct ${field} to point to a readable ${kind}.`, {
            cause: error,
          });
        }
      },
      { signal },
    );
  }
}
