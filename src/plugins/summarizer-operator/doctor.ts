import type { DoctorContext, DoctorRule } from '../../contracts/index.js';
import type { OperatorSummarizerConfig } from './schema.js';
import { readSummaryPrompt } from './service.js';

export function operatorSummarizerDoctorRules(
  context: DoctorContext<OperatorSummarizerConfig>,
): DoctorRule[] {
  async function isPromptReady(signal: AbortSignal): Promise<boolean> {
    await readSummaryPrompt(context.binding.config.promptFile, signal);
    return true;
  }

  return [
    {
      id: 'prompt-content',
      check: isPromptReady,
      reason:
        'Restore a readable, nonempty operator summary prompt or correct promptFile.',
    },
  ];
}
