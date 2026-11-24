import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DoctorContext,
  DoctorResult,
  JsonObject,
} from '../../../contracts/index.js';
import {
  failed,
  passed,
  runDoctorProbe,
} from '../../../shared/doctor-check.js';
import { errorText } from '../../../shared/errors.js';
import { object, string } from '../../../shared/json.js';
import {
  evaluatorNetworkConfigPath,
  type SdkEvaluatorConfig,
} from './configuration.js';
import { sdkDoctor, type SdkDoctorRunner } from './doctor-sdk.js';

export async function checkSdkDoctor(
  context: DoctorContext,
  prepareConfig: (
    context: DoctorContext,
    env: NodeJS.ProcessEnv,
  ) => SdkEvaluatorConfig | Promise<SdkEvaluatorConfig>,
  run: SdkDoctorRunner = sdkDoctor,
): Promise<DoctorResult> {
  const configuration = await runDoctorProbe(
    'configuration',
    async (signal) => {
      const env = { ...process.env };
      const config = await prepareConfig(context, env);
      const configPath = join(context.directory, 'evaluator.json');
      await writeFile(configPath, JSON.stringify(config), {
        mode: 0o600,
        signal,
      });
      return {
        configPath,
        networkConfigPath: await networkConfigPath(context.directory, signal),
        env,
      };
    },
    { signal: context.signal },
  );
  const options = configuration.value;
  if (!options)
    return failed(
      configuration.check.id,
      configuration.check.reason,
      configuration.check.details,
    );
  let result: SdkReport;
  try {
    // The SDK owns the complete diagnostic workflow and its per-probe limits.
    result = parseSdkDoctorReport(
      await run({ ...options, signal: context.signal }),
    );
    context.signal.throwIfAborted();
  } catch (error) {
    context.signal.throwIfAborted();
    return failed(
      'sdk-doctor',
      `Evaluator SDK doctor could not complete. Check ${context.binding.name}.config, the installed SDK and its resources. ${errorText(error)}`,
    );
  }
  for (const [index, check] of result.checks.entries()) {
    if (check.status === 'failed')
      return failed(
        `sdk.check-${index}`,
        `${check.name}: ${check.detail} Correct ${context.binding.name}.config and the SDK prerequisites named by this check.`,
        {
          sdkName: check.name,
          sdkStatus: check.status,
        },
      );
  }
  const networkStatus = string(result.network.status);
  if (networkStatus === 'failed')
    return failed(
      'sdk.network',
      'Evaluator SDK network probes failed. Correct the download or proxy configuration named in the SDK guidance.',
      result.network,
    );
  return {
    checks: [
      configuration.check,
      ...passed(
        'sdk-doctor',
        'Evaluator SDK doctor returned its diagnostic report.',
      ).checks,
      ...result.checks.map((check, index) => ({
        id: `sdk.check-${index}`,
        status: doctorStatus(check.status),
        reason: `${check.name}: ${check.detail}`,
        details: { sdkName: check.name, sdkStatus: check.status },
      })),
      {
        id: 'sdk.network',
        status: doctorStatus(networkStatus),
        reason:
          networkStatus === 'passed'
            ? 'Evaluator SDK network probes passed; see the SDK probe evidence for their scope.'
            : 'Evaluator SDK network probes did not all pass; inspect the SDK probe evidence and guidance.',
        details: result.network,
      },
    ],
  };
}

async function networkConfigPath(
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const configured = evaluatorNetworkConfigPath();
  if (process.env.EVALUATOR_NETWORK_CONFIG) return configured;
  try {
    await lstat(configured);
    return configured;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  // Native doctor must not initialize configuration in the user's home.
  const path = join(directory, 'network.yaml');
  await writeFile(path, '{}\n', { mode: 0o600, signal });
  return path;
}

type NativeStatus = 'passed' | 'failed' | 'not-checked';
type SdkReport = {
  checks: { name: string; status: NativeStatus; detail: string }[];
  network: JsonObject;
};

function parseSdkDoctorReport(value: unknown): SdkReport {
  const native = object(value, 'SDK doctor report');
  if (!Array.isArray(native.checks) || !native.checks.length)
    throw new Error('SDK doctor report.checks must be a nonempty array');
  const checks = native.checks.map((value): SdkReport['checks'][number] => {
    const check = object(value, 'SDK doctor check');
    const name = string(check.name, 'SDK doctor check.name');
    if (typeof check.detail !== 'string')
      throw new Error('SDK doctor check.detail must be a string');
    const detail = check.detail;
    const status = check.status;
    if (status !== 'passed' && status !== 'failed' && status !== 'not-checked')
      throw new Error('SDK doctor check has an unsupported status');
    return { name, status, detail };
  });
  const network = object(native.network, 'SDK doctor network');
  if (
    !['passed', 'failed', 'incomplete', 'not-checked'].includes(
      string(network.status),
    )
  )
    throw new Error('SDK doctor network has an unsupported status');
  if (!Array.isArray(network.probes))
    throw new Error('SDK doctor network.probes must be an array');
  for (const raw of network.probes) {
    const probe = object(raw, 'SDK doctor network probe');
    string(probe.name, 'SDK doctor network probe.name');
    if (typeof probe.evidence !== 'string')
      throw new Error('SDK doctor network probe.evidence must be a string');
    if (
      !['passed', 'failed', 'not-checked', 'not-applicable'].includes(
        string(probe.status),
      )
    )
      throw new Error('SDK doctor network probe has an unsupported status');
    if (
      network.status === 'passed' &&
      (probe.status === 'failed' || probe.status === 'not-checked')
    )
      throw new Error(
        'SDK doctor network summary contradicts its probe results',
      );
  }
  return { checks, network };
}

function doctorStatus(
  status: string,
): DoctorResult['checks'][number]['status'] {
  return status === 'passed' || status === 'failed' ? status : 'unchecked';
}
