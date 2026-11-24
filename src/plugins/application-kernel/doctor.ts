import type {
  DoctorContext,
  DoctorStep,
  Operation,
} from '../../contracts/index.js';
import { checkFileApplication } from '../shared/file-application/doctor.js';
import { kernelSourcePath } from './schema.js';

export function checkKernelApplication(
  context: DoctorContext,
  operation: Operation,
): DoctorStep[] {
  return checkFileApplication(context, operation, {
    verification: 'verify-source',
    capability: 'kernel-source',
    entryFile: kernelSourcePath(context.binding.config.entryFile),
  });
}
