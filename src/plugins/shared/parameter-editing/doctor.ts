import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DoctorContext, DoctorRule } from '../../../contracts/index.js';
import { object } from '../../../shared/json.js';
import { requireReadablePath } from '../doctor/checks.js';
import { safePath } from '../file-application/target.js';

export function parameterFileDoctorRules(context: DoctorContext): DoctorRule[] {
  const baseline = context.recipe.application.config.baseline;
  const { directory, artifactRef } =
    baseline && typeof baseline === 'object' && !Array.isArray(baseline)
      ? baseline
      : {};
  const hasBaseline =
    (typeof directory === 'string' && directory.length > 0) ||
    (typeof artifactRef === 'string' && artifactRef.length > 0);
  const field = `${context.binding.name}.config.path`;

  async function isParameterFileReadable(
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const path = safePath(context.binding.config.path);
    let temporary: string | undefined;
    try {
      let baselineDirectory: string;
      if (typeof directory === 'string' && directory) {
        baselineDirectory = resolve(context.runtime.rootDirectory, directory);
      } else {
        await mkdir(context.directory, { recursive: true });
        temporary = await mkdtemp(
          join(context.directory, 'parameter-baseline-'),
        );
        baselineDirectory = temporary;
        await context.runtime.artifacts.materialize(
          String(artifactRef),
          baselineDirectory,
        );
      }
      signal.throwIfAborted();
      const file = join(baselineDirectory, path);
      await requireReadablePath(file, field, 'file');
      object(
        JSON.parse(await readFile(file, { encoding: 'utf8', signal })),
        field,
      );
      signal.throwIfAborted();
      return true;
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  return [
    {
      id: 'parameter-file',
      check: hasBaseline ? isParameterFileReadable : undefined,
      reason: hasBaseline
        ? `Restore a readable JSON object parameter file (${String(context.binding.config.path)}) in the Application baseline, or correct ${field} and application.config.baseline.`
        : `The Application does not expose a baseline directory or artifact; ${field} readability is unchecked.`,
    },
  ];
}
