import { object } from '../../shared/json.js';
import { launchEnvironment } from './session.js';
import type {
  DoctorContext,
  DoctorResult,
  JsonValue,
} from '../../contracts/index.js';
import { failed, passed, runDoctorCheck } from '../../shared/doctor-check.js';
import {
  checkNativeAgentExecutable,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkOpenCodeAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const executable = await checkNativeAgentExecutable(
    context,
    'opencode',
    ['run', '--help'],
    ['--standalone', '--format', '--model', '--archived'],
  );
  if (executable.status === 'failed')
    return failed(executable.id, executable.reason, executable.details);
  const version = await runDoctorCheck(
    'version',
    (signal) => checkOpenCodeVersion(context, signal),
    { signal: context.signal },
  );
  if (version.status === 'failed')
    return failed(version.id, version.reason, version.details);
  const configuration = await runDoctorCheck(
    'configuration',
    (signal) => checkOpenCodeConfiguration(context, signal),
    { signal: context.signal },
  );
  if (configuration.status === 'failed')
    return failed(
      configuration.id,
      configuration.reason,
      configuration.details,
    );
  const modelAccess: DoctorResult['checks'][number] = {
    id: 'model-access',
    status: 'unchecked',
    reason:
      'Native preflight does not establish model-service reachability or model availability. Verify model access in the native client before running RSI.',
  };
  return {
    checks: [
      executable,
      version,
      ...passed('configuration').checks,
      modelAccess,
    ],
  };
}

async function checkOpenCodeVersion(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<void> {
  const version = await runNativeAgentCommand(
    context,
    'opencode',
    ['--version'],
    signal,
  );
  if (!/^opencode v2\.(\d+)\.(\d+)\s*$/.test(version.trim()))
    throw new Error(
      'Install OpenCode V2 using the official @opencode/cli package.',
    );
}

async function checkOpenCodeConfiguration(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<void> {
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
    if (
      !Array.isArray(entries) ||
      !entries.some((entry: JsonValue) => object(entry).info !== undefined)
    )
      throw new Error('missing native configuration');
  } catch {
    throw new Error('OpenCode could not load its native configuration.');
  }
}
