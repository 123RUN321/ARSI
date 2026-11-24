import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import {
  failed,
  passed,
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
    (signal) => checkOperatorTask(config, signal),
    options,
  );
  if (operatorTask.status === 'failed')
    return failed(operatorTask.id, operatorTask.reason, operatorTask.details);
  const resources = await runDoctorCheck(
    'operator-resources',
    (signal) => checkOperatorResources(config, signal),
    options,
  );
  if (resources.status === 'failed')
    return failed(resources.id, resources.reason, resources.details);
  if (config.hardwareContextFile) {
    const path = config.hardwareContextFile;
    const hardware = await runDoctorCheck(
      'hardware-context',
      async () => {
        await readHardwareContext(path);
      },
      options,
    );
    if (hardware.status === 'failed')
      return failed(
        hardware.id,
        `Check hardwareContextFile (${path}) and restore a readable hardware description. ${hardware.reason}`,
        hardware.details,
      );
  }
  return passed(
    'operator-resources',
    'Operator task, prompts, retrieval inputs and optional hardware context were verified.',
  );
}

async function checkOperatorTask(
  config: OperatorProposerConfig,
  signal: AbortSignal,
): Promise<void> {
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
}

async function checkOperatorResources(
  config: OperatorProposerConfig,
  signal: AbortSignal,
): Promise<void> {
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
}
