import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseFileTree,
  type DoctorContext,
  type DoctorRule,
} from '../../contracts/index.js';
import { missingInputError } from '../../shared/doctor-check.js';
import { parseConfig } from '../../shared/schema.js';
import { missingPath } from '../shared/doctor/checks.js';
import { configSchema, type ParetoEvolutionConfig } from './schema.js';
import { validateModules } from './service.js';

export function checkParetoEvolutionProposer(
  context: DoctorContext,
): DoctorRule[] {
  context.signal.throwIfAborted();
  const config = parseConfig<ParetoEvolutionConfig>(
    configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const baseline = context.recipe.application.config.baseline;
  const { artifactRef, directory } =
    baseline && typeof baseline === 'object' && !Array.isArray(baseline)
      ? baseline
      : {};
  function areModulesValid(signal: AbortSignal): boolean {
    signal.throwIfAborted();
    validateModules(config.modules);
    return true;
  }
  async function areBaselineModulesAvailable(
    signal: AbortSignal,
  ): Promise<boolean> {
    if (typeof artifactRef === 'string')
      await checkArtifactModules(context, config, artifactRef, signal);
    else if (typeof directory === 'string' && directory)
      await checkDirectoryModules(config, directory, signal);
    return true;
  }
  const hasBaseline =
    typeof artifactRef === 'string' ||
    (typeof directory === 'string' && directory.length > 0);
  return [
    {
      id: 'modules',
      check: areModulesValid,
      reason: 'Correct modules, including unique identities and safe paths.',
    },
    {
      id: 'baseline-modules',
      check: hasBaseline ? areBaselineModulesAvailable : undefined,
      reason: hasBaseline
        ? 'Restore the baseline module files or correct their configured paths.'
        : 'The Application does not expose a local baseline directory or artifact.',
    },
  ];
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
