import type { DoctorContext, DoctorRule } from '../../contracts/index.js';
import { checkAgentEditor } from '../shared/agent-editing/doctor.js';
import type { AgentEditingConfig } from './schema.js';

export function checkProposerAgent(context: DoctorContext): DoctorRule[] {
  return checkAgentEditor<AgentEditingConfig>(context, (config) =>
    (config.subagents ?? []).map((role, index) => ({
      role,
      promptField: `subagents.${index}.prompt`,
    })),
  );
}
