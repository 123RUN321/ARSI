import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseFileTree,
  type DoctorContext,
  type DoctorResult,
} from '../../contracts/index.js';
import {
  DoctorMissingResourceError,
  runDoctorCheck,
} from '../../shared/doctor-check.js';
import { parseConfig } from '../../shared/schema.js';
import { missingPath } from '../shared/doctor/checks.js';
import { configSchema, type ParetoEvolutionConfig } from './schema.js';
import { validateModules } from './service.js';

export async function checkParetoEvolutionProposer(
  context: DoctorContext,
): Promise<DoctorResult> {
  const config = parseConfig<ParetoEvolutionConfig>(
    configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const options = { signal: context.signal };
  const modules = await runDoctorCheck(
    'modules',
    async () => validateModules(config.modules),
    options,
  );
  if (modules.status !== 'passed') {
    return {
      checks: [
        modules,
        {
          id: 'baseline-modules',
          status: 'unchecked',
          reason: 'The module configuration is invalid.',
          blockedBy: modules.id,
        },
      ],
    };
  }
  const baseline = context.recipe.application.config.baseline;
  const { artifactRef, directory } =
    baseline && typeof baseline === 'object' && !Array.isArray(baseline)
      ? baseline
      : {};
  if (typeof artifactRef === 'string') {
    const baselineModules = await runDoctorCheck(
      'baseline-modules',
      async (signal) => {
        signal.throwIfAborted();
        const tree = parseFileTree(
          await context.runtime.artifacts.readJson(artifactRef),
        );
        for (const module of config.modules)
          if (!tree.files.some((file) => file.path === module.path))
            throw new Error(
              `GEPA module is missing from baseline artifact: ${module.path}`,
            );
      },
      options,
    );
    return { checks: [modules, baselineModules] };
  }
  if (typeof directory !== 'string' || !directory) {
    return {
      checks: [
        modules,
        {
          id: 'baseline-modules',
          status: 'unchecked',
          reason: 'The Application does not expose a local baseline directory.',
        },
      ],
    };
  }
  const baselineModules = await runDoctorCheck(
    'baseline-modules',
    async (signal) => {
      try {
        if (!(await lstat(directory)).isDirectory())
          throw new Error(`Expected baseline directory: ${directory}`);
      } catch (error) {
        if (missingPath(error))
          throw new DoctorMissingResourceError(
            {
              field: 'application.config.baseline.directory',
              kind: 'directory',
              reference: directory,
            },
            error,
          );
        throw error;
      }
      for (const module of config.modules) {
        signal.throwIfAborted();
        const path = join(directory, module.path);
        try {
          if (!(await lstat(path)).isFile())
            throw new Error(`GEPA module must be a regular file: ${path}`);
          await readFile(path, { signal });
        } catch (error) {
          if (missingPath(error))
            throw new DoctorMissingResourceError(
              {
                field: `modules.${module.id}.path`,
                kind: 'file',
                reference: path,
              },
              error,
            );
          throw error;
        }
      }
    },
    options,
  );
  return { checks: [modules, baselineModules] };
}
