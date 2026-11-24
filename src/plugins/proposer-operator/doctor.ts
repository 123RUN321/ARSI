import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import {
  missingInputError,
  runDoctorCheck,
} from '../../shared/doctor-check.js';
import { parseConfig } from '../../shared/schema.js';
import { missingPath } from '../shared/doctor/checks.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import type { OperatorProposerConfig } from './schema.js';
import { loadOperatorResources, readHardwareContext } from './resources.js';

export async function checkOperatorProposer(
  context: DoctorContext,
): Promise<DoctorResult> {
  const config = parseConfig<OperatorProposerConfig>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const options = { signal: context.signal };
  const operatorTask = await runDoctorCheck(
    'operator-task',
    async (signal) => {
      signal.throwIfAborted();
      try {
        await loadOperatorTask(config.task.directory);
      } catch (error) {
        const path = missingPath(error);
        if (path)
          throw missingInputError(
            { field: 'task.directory', kind: 'file', reference: path },
            error,
          );
        throw error;
      }
    },
    options,
  );
  const resources = await runDoctorCheck(
    'operator-resources',
    async (signal) => {
      signal.throwIfAborted();
      try {
        await loadOperatorResources(config);
      } catch (error) {
        const path = missingPath(error);
        if (path)
          throw missingInputError(
            {
              field: path.startsWith(config.promptsDirectory)
                ? 'promptsDirectory'
                : path === config.embedding.retrievalScript
                  ? 'embedding.retrievalScript'
                  : 'embedding.resourcesDirectory',
              kind: 'file',
              reference: path,
            },
            error,
          );
        throw error;
      }
    },
    options,
  );
  const checks = [operatorTask, resources];
  const hardwareContextFile = config.hardwareContextFile;
  if (hardwareContextFile)
    checks.push(
      await runDoctorCheck(
        'hardware-context',
        async () => {
          await readHardwareContext(hardwareContextFile);
        },
        options,
      ),
    );
  return { checks };
}
