import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseFileTree,
  type DoctorContext,
  type DoctorResult,
} from '../../contracts/index.js';
import {
  failed,
  passed,
  missingInputError,
  runDoctorCheck,
} from '../../shared/doctor-check.js';
import { errorText } from '../../shared/errors.js';
import { parseConfig } from '../../shared/schema.js';
import { missingPath } from '../shared/doctor/checks.js';
import { configSchema, type ParetoEvolutionConfig } from './schema.js';
import { validateModules } from './service.js';

export async function checkParetoEvolutionProposer(
  context: DoctorContext,
): Promise<DoctorResult> {
  context.signal.throwIfAborted();
  const config = parseConfig<ParetoEvolutionConfig>(
    configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  try {
    validateModules(config.modules);
  } catch (error) {
    context.signal.throwIfAborted();
    return failed(
      'modules',
      `Correct modules, including unique identities and safe paths. ${errorText(error)}`,
    );
  }

  const baseline = context.recipe.application.config.baseline;
  const { artifactRef, directory } =
    baseline && typeof baseline === 'object' && !Array.isArray(baseline)
      ? baseline
      : {};
  if (typeof artifactRef === 'string') {
    const files = await runDoctorCheck(
      'baseline-modules',
      (signal) => checkArtifactModules(context, config, artifactRef, signal),
      { signal: context.signal },
    );
    if (files.status === 'failed')
      return failed(files.id, files.reason, files.details);
    return passed('baseline-modules');
  }
  if (typeof directory !== 'string' || !directory)
    return {
      checks: [
        {
          id: 'baseline-modules',
          status: 'unchecked',
          reason: 'The Application does not expose a local baseline directory.',
        },
      ],
    };

  const files = await runDoctorCheck(
    'baseline-modules',
    (signal) => checkDirectoryModules(config, directory, signal),
    { signal: context.signal },
  );
  if (files.status === 'failed')
    return failed(files.id, files.reason, files.details);
  return passed('baseline-modules');
}

async function checkArtifactModules(
  context: DoctorContext,
  config: ParetoEvolutionConfig,
  artifactRef: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const tree = parseFileTree(
    await context.runtime.artifacts.readJson(artifactRef),
  );
  for (const module of config.modules) {
    signal.throwIfAborted();
    if (!tree.files.some((file) => file.path === module.path))
      throw new Error(
        `GEPA module is missing from baseline artifact: ${module.path}. Correct modules.${module.id}.path or application.config.baseline.artifactRef.`,
      );
  }
}

async function checkDirectoryModules(
  config: ParetoEvolutionConfig,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error(
        `Expected baseline directory: ${directory}. Correct application.config.baseline.directory.`,
      );
  } catch (error) {
    if (missingPath(error))
      throw missingInputError(
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
        throw new Error(
          `GEPA module must be a regular file: ${path}. Correct modules.${module.id}.path.`,
        );
      await readFile(path, { signal });
    } catch (error) {
      if (missingPath(error))
        throw missingInputError(
          { field: `modules.${module.id}.path`, kind: 'file', reference: path },
          error,
        );
      throw error;
    }
  }
}
