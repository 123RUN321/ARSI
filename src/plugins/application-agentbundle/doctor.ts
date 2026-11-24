import type {
  DoctorContext,
  DoctorStep,
  Operation,
} from '../../contracts/index.js';
import { checkFileApplication } from '../shared/file-application/doctor.js';

export function checkAgentbundleApplication(
  context: DoctorContext,
  operation: Operation,
): DoctorStep[] {
  return checkFileApplication(context, operation, {
    verification: 'verify-bundle',
    capability: 'agentbundle',
    entryFile: 'bundle.yaml',
  });
}
