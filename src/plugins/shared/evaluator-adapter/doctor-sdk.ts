import { runSdkCli, type SdkCliOptions } from './cli.js';

export interface SdkDoctorOptions extends SdkCliOptions {
  networkConfigPath: string;
}

export type SdkDoctorRunner = (options: SdkDoctorOptions) => Promise<unknown>;

export const sdkDoctor: SdkDoctorRunner = (options) =>
  runSdkCli({ ...options, command: 'doctor' });
