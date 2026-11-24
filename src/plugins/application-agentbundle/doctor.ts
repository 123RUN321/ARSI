import type {
  DoctorContext,
  DoctorRule,
  Operation,
} from '../../contracts/index.js';
import { fileApplicationDoctorRules } from '../shared/file-application/doctor.js';

export function checkAgentbundleApplication(
  context: DoctorContext,
  operation: Operation,
): DoctorRule[] {
  return fileApplicationDoctorRules(context, operation, {
    verification: 'verify-bundle',
    capability: 'agentbundle',
    entryFile: 'bundle.yaml',
  });
}
