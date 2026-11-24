import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DoctorContext,
  DoctorRule,
  JsonObject,
} from '../../../contracts/index.js';
import { object, string } from '../../../shared/json.js';
import {
  evaluatorNetworkConfigPath,
  type SdkEvaluatorConfig,
} from './configuration.js';
import {
  sdkDoctor,
  type SdkDoctorOptions,
  type SdkDoctorRunner,
} from './doctor-sdk.js';

export function sdkDoctorRules(
  context: DoctorContext,
  prepareConfig: (
    context: DoctorContext,
    env: NodeJS.ProcessEnv,
  ) => SdkEvaluatorConfig | Promise<SdkEvaluatorConfig>,
  run: SdkDoctorRunner = sdkDoctor,
): DoctorRule[] {
  let options: SdkDoctorOptions;
  let report: SdkReport;

  async function isConfigurationReady(signal: AbortSignal): Promise<boolean> {
    const env = { ...process.env };
    const config = await prepareConfig({ ...context, signal }, env);
    const configPath = join(context.directory, 'evaluator.json');
    await writeFile(configPath, JSON.stringify(config), {
      mode: 0o600,
      signal,
    });
    options = {
      configPath,
      networkConfigPath: await networkConfigPath(context.directory, signal),
      env,
      signal,
    };
    return true;
  }

  async function isSdkReady(signal: AbortSignal): Promise<boolean> {
    // The SDK owns the complete diagnostic workflow and its per-probe limits.
    report = parseSdkDoctorReport(await run({ ...options, signal }));
    signal.throwIfAborted();
    return !report.checks.some((check) => check.status === 'failed');
  }

  function isNetworkReady(): boolean {
    return report.network.status === 'passed';
  }

  return [
    {
      id: 'configuration',
      check: isConfigurationReady,
      reason: `Correct ${context.binding.name}.config and restore the Application inputs required by this Evaluator.`,
    },
    {
      id: 'sdk-doctor',
      check: isSdkReady,
      timeoutMs: null,
      get reason() {
        const failures =
          report?.checks.filter((check) => check.status === 'failed') ?? [];
        return (
          `Check ${context.binding.name}.config, the installed SDK and its prerequisites. ` +
          failures.map((check) => `${check.name}: ${check.detail}`).join(' ') +
          (failures.some((check) => check.name === 'AgentBundle path')
            ? ' Restore the AgentBundle or correct application.config.baseline.directory.'
            : '')
        );
      },
      get details() {
        return report
          ? { checks: report.checks, network: report.network }
          : undefined;
      },
    },
    {
      id: 'sdk.coverage',
      get check() {
        return report?.checks.some((check) => check.status === 'not-checked')
          ? undefined
          : () => true;
      },
      get reason() {
        return (
          (report?.checks
            .filter((check) => check.status === 'not-checked')
            .map((check) => `${check.name}: ${check.detail}`)
            .join(' ') ??
            '') ||
          'SDK prerequisite coverage was not established.'
        );
      },
    },
    {
      id: 'sdk.network',
      get check() {
        return ['passed', 'failed'].includes(String(report?.network.status))
          ? isNetworkReady
          : undefined;
      },
      reason:
        'SDK network readiness was not established. Inspect the probe evidence and correct the download or proxy fields named in its guidance.',
      get details() {
        return report?.network;
      },
    },
  ];
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
