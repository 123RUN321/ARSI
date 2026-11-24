import { object } from '../../shared/json.js';
import { launchEnvironment } from './session.js';
import type {
  DoctorContext,
  DoctorRule,
  JsonValue,
} from '../../contracts/index.js';
import {
  isNativeAgentCompatible,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export function checkOpenCodeAgent(context: DoctorContext): DoctorRule[] {
  const isExecutableCompatible = (signal: AbortSignal): Promise<boolean> =>
    isNativeAgentCompatible(
      context,
      'opencode',
      ['run', '--help'],
      ['--standalone', '--format', '--model', '--archived'],
      signal,
    );
  const isVersionSupported = (signal: AbortSignal): Promise<boolean> =>
    isOpenCodeVersionSupported(context, signal);
  const isConfigurationValid = (signal: AbortSignal): Promise<boolean> =>
    isOpenCodeConfigurationValid(context, signal);

  return [
    {
      id: 'executable',
      check: isExecutableCompatible,
      reason: `The CLI lacks required CLI options. Check ${context.binding.name}.config.executable and upgrade the native CLI.`,
    },
    {
      id: 'version',
      check: isVersionSupported,
      reason:
        'Install OpenCode V2 using the official @opencode/cli package and correct executable.',
    },
    {
      id: 'configuration',
      check: isConfigurationValid,
      reason:
        'OpenCode could not load its native configuration. Check executable, upgrade the native CLI and repair its configuration.',
    },
    {
      id: 'model-access',
      reason:
        'Native preflight does not establish model-service reachability or model availability. Verify model access in the native client before running RSI.',
    },
  ];
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
