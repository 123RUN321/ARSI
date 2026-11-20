import { diagnoseExperiment, type DoctorOptions } from 'arsi-evaluator';

export type SdkDoctorOptions = Required<
  Pick<DoctorOptions, 'configPath' | 'networkConfigPath' | 'env' | 'signal'>
>;

export type SdkDoctorRunner = (options: SdkDoctorOptions) => Promise<unknown>;

export const sdkDoctor = diagnoseExperiment;
