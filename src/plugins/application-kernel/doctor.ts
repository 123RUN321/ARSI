import type {
  DoctorContext,
  DoctorResult,
  Operation,
} from '../../contracts/index.js';
import { checkFileApplication } from '../shared/file-application/doctor.js';
import { kernelSourcePath } from './schema.js';

export async function checkKernelApplication(
  context: DoctorContext,
  operation: Operation,
): Promise<DoctorResult> {
  return checkFileApplication(context, operation, {
    verification: 'verify-source',
    capability: 'kernel-source',
    entryFile: kernelSourcePath(context.binding.config.entryFile),
  });
}
