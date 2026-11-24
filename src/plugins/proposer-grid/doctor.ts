import type { DoctorContext, DoctorRule } from '../../contracts/index.js';
import { configurationDoctorRules } from '../shared/doctor/checks.js';
import { parameterFileDoctorRules } from '../shared/parameter-editing/doctor.js';

export function gridDoctorRules(context: DoctorContext): DoctorRule[] {
  return [...configurationDoctorRules(), ...parameterFileDoctorRules(context)];
}
