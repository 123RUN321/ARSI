import type { DoctorContext, DoctorStep } from '../../contracts/index.js';
import { missingInputError } from '../../shared/doctor-check.js';
import { parseConfig } from '../../shared/schema.js';
import { missingPath } from '../shared/doctor/checks.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import type { OperatorProposerConfig } from './schema.js';
import { loadOperatorResources, readHardwareContext } from './resources.js';

export function checkOperatorProposer(context: DoctorContext): DoctorStep[] {
  context.signal.throwIfAborted();
  const config = parseConfig<OperatorProposerConfig>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  async function isTaskValid(signal: AbortSignal): Promise<boolean> {
    await checkOperatorTask(config, signal);
    return true;
  }
  async function areResourcesAvailable(signal: AbortSignal): Promise<boolean> {
    await checkOperatorResources(config, signal);
    return true;
  }
  async function isHardwareContextReadable(
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (config.hardwareContextFile)
      await readHardwareContext(config.hardwareContextFile);
    signal.throwIfAborted();
    return true;
  }
  return [
    {
      id: 'operator-task',
      check: isTaskValid,
      reason: 'Correct task.directory and restore the operator task files.',
    },
    {
      id: 'operator-resources',
      check: areResourcesAvailable,
      reason:
        'Restore the configured prompts and external operator knowledge inputs.',
    },
    {
      id: 'hardware-context',
      check: config.hardwareContextFile ? isHardwareContextReadable : undefined,
      reason: config.hardwareContextFile
        ? `Check hardwareContextFile (${config.hardwareContextFile}) and restore a readable hardware description.`
        : 'No optional hardwareContextFile is configured.',
    },
  ];
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
