import type { DoctorContext, DoctorRule } from '../../contracts/index.js';
import { agentEditorDoctorRules } from '../shared/agent-editing/doctor.js';
import { reflectionReviewer } from './service.js';

export function checkReflectionAgent(context: DoctorContext): DoctorRule[] {
  return agentEditorDoctorRules(context, () => [
    { role: reflectionReviewer, promptField: 'bundledReviewer.prompt' },
  ]);
}
