import type {
  DoctorContext,
  DoctorResult,
  Operation,
} from '../../contracts/index.js';
import { checkFileApplication } from '../shared/file-application/doctor.js';

export async function checkAgentbundleApplication(
  context: DoctorContext,
  operation: Operation,
): Promise<DoctorResult> {
  return checkFileApplication(context, operation, {
    verification: 'verify-bundle',
    capability: 'agentbundle',
    entryFile: 'bundle.yaml',
  });
}
