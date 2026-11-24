import { object } from '../../shared/json.js';
import { launchEnvironment } from './session.js';
import type {
  DoctorContext,
  DoctorResult,
  JsonValue,
} from '../../contracts/index.js';
import { failed, passed, runDoctorProbe } from '../../shared/doctor-check.js';
import {
  isNativeAgentCompatible,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkOpenCodeAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const executable = await runDoctorProbe(
    'executable',
    (signal) =>
      isNativeAgentCompatible(
        context,
        'opencode',
        ['run', '--help'],
        ['--standalone', '--format', '--model', '--archived'],
        signal,
      ),
    { signal: context.signal },
  );
  if (!executable.value)
    return failed(
      'executable',
      executable.check.reason ??
        `The CLI lacks required CLI options. Check ${context.binding.name}.config.executable and upgrade the native CLI.`,
    );
  const version = await runDoctorProbe(
    'version',
    (signal) => isOpenCodeVersionSupported(context, signal),
    { signal: context.signal },
  );
  if (!version.value)
    return failed(
      'version',
      version.check.reason ??
        'Install OpenCode V2 using the official @opencode/cli package and correct executable.',
    );
  const configuration = await runDoctorProbe(
    'configuration',
    (signal) => isOpenCodeConfigurationValid(context, signal),
    { signal: context.signal },
  );
  if (!configuration.value)
    return failed(
      'configuration',
      configuration.check.reason ??
        'OpenCode could not load its native configuration. Check executable, upgrade the native CLI and repair its configuration.',
    );
  const modelAccess: DoctorResult['checks'][number] = {
    id: 'model-access',
    status: 'unchecked',
    reason:
      'Native preflight does not establish model-service reachability or model availability. Verify model access in the native client before running RSI.',
  };
  return {
    checks: [
      ...passed('executable').checks,
      ...passed('version').checks,
      ...passed('configuration').checks,
      modelAccess,
    ],
  };
}

async function isOpenCodeVersionSupported(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<boolean> {
  const version = await runNativeAgentCommand(
    context,
    'opencode',
    ['--version'],
    signal,
  );
  return /^opencode v2\.(\d+)\.(\d+)\s*$/.test(version.trim());
}

async function isOpenCodeConfigurationValid(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<boolean> {
  const stdout = await runNativeAgentCommand(
    context,
    'opencode',
    ['debug', 'config', '--standalone'],
    signal,
    [0],
    launchEnvironment(context.directory),
  );
  try {
    const entries: JsonValue = JSON.parse(stdout);
    return (
      Array.isArray(entries) &&
      entries.some((entry: JsonValue) => object(entry).info !== undefined)
    );
  } catch {
    return false;
  }
}
