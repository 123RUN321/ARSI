import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import {
  failed,
  passed,
  missingInputError,
  runDoctorCheck,
} from '../../shared/doctor-check.js';
import { object, string } from '../../shared/json.js';
import { executablePath } from '../shared/doctor/executable.js';
import { runCommand } from '../shared/doctor/process.js';
import {
  checkBaselineDirectory,
  requirePath,
} from '../shared/file-application/doctor.js';
import { safePath } from '../shared/file-application/target.js';
import type {
  InferenceConfig,
  LocalInferenceConfig,
  RemoteInferenceConfig,
} from './schema.js';

export async function checkInferenceApplication(
  context: DoctorContext<InferenceConfig>,
): Promise<DoctorResult> {
  const baseline = await checkBaselineDirectory(context);
  const directory = baseline.directory;
  if (!directory)
    return failed(
      baseline.check.id,
      baseline.check.reason,
      baseline.check.details,
    );

  const config = context.binding.config;
  const options = { signal: context.signal };
  if ('remote' in config) {
    const interpreter = await runDoctorCheck(
      'remote-executable',
      (signal) => checkRemoteInterpreter(config.remote, signal),
      options,
    );
    if (interpreter.status === 'failed')
      return failed(interpreter.id, interpreter.reason, interpreter.details);
  }

  const launch = await runDoctorCheck(
    'launch-prerequisites',
    async (signal) => {
      if ('remote' in config)
        await checkRemoteParameters(config.remote, directory, signal);
      else await checkLocalLaunch(config, directory);
      signal.throwIfAborted();
    },
    options,
  );
  if (launch.status === 'failed')
    return failed(launch.id, launch.reason, launch.details);
  const apiKeyEnv = config.credentials?.apiKeyEnv;
  if (apiKeyEnv !== undefined && !process.env[apiKeyEnv]?.trim())
    return failed(
      'credentials',
      `credentials.apiKeyEnv references missing or empty environment variable ${apiKeyEnv}. Set that variable before running the experiment.`,
    );
  return passed('launch-prerequisites');
}

async function checkRemoteInterpreter(
  remote: RemoteInferenceConfig['remote'],
  signal: AbortSignal,
): Promise<void> {
  const executable = remote.executable ?? 'python3';
  await executablePath(executable, process.cwd());
  await runCommand(executable, ['--version'], { signal });
}

async function checkRemoteParameters(
  remote: RemoteInferenceConfig['remote'],
  baseline: string,
  signal: AbortSignal,
): Promise<void> {
  const parameters = join(
    baseline,
    safePath(remote.parametersFile ?? 'tuning.json'),
  );
  await requirePath(parameters, 'remote.parametersFile', 'file');
  object(
    JSON.parse(await readFile(parameters, { encoding: 'utf8', signal })),
    'remote parameters',
  );
}

async function checkLocalLaunch(
  config: LocalInferenceConfig,
  baseline: string,
): Promise<void> {
  const { start, resources = {} } = config;
  const expand = (
    argument: LocalInferenceConfig['start']['argv'][number],
  ): string => {
    if (typeof argument === 'string') return argument;
    const base =
      argument.resource === 'workspace'
        ? baseline
        : argument.resource === 'port'
          ? '0'
          : string(
              resources[argument.resource],
              `resources.${argument.resource}`,
            );
    return argument.path === undefined
      ? base
      : join(base, safePath(argument.path));
  };
  const argv = start.argv.map(expand);
  const cwd =
    start.cwd === undefined ? baseline : join(baseline, safePath(start.cwd));
  await requirePath(cwd, 'start.cwd', 'directory');
  await executablePath(string(argv[0], 'start.argv[0]'), cwd);
  for (const [index, argument] of start.argv.entries()) {
    if (typeof argument === 'string' || argument.resource === 'port') continue;
    const reference = resolve(cwd, expand(argument));
    try {
      await access(reference, constants.R_OK);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw missingInputError(
          { field: `start.argv.${index}`, kind: 'path', reference },
          error,
        );
      throw error;
    }
  }
}
