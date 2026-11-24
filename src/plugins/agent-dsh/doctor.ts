import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { parseDocument } from 'yaml';
import { failed, passed, runDoctorCheck } from '../../shared/doctor-check.js';
import {
  checkNativeAgentExecutable,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkDshAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const executable = await checkNativeAgentExecutable(
    context,
    'dsh',
    ['--profile', 'headless', '--help'],
    ['--json', '--permission-mode', '--approval-policy'],
  );
  if (executable.status === 'failed')
    return failed(executable.id, executable.reason, executable.details);
  const profile = await runDoctorCheck(
    'profile-config',
    (signal) => checkDshProfile(context, signal),
    { signal: context.signal },
  );
  if (profile.status === 'failed')
    return failed(profile.id, profile.reason, profile.details);
  const modelAccess: DoctorResult['checks'][number] = {
    id: 'model-access',
    status: 'unchecked',
    reason:
      'Native preflight does not establish model-service reachability or model availability. Verify model access in the native client before running RSI.',
  };
  return {
    checks: [
      executable,
      ...passed('profile-config').checks,
      {
        id: 'doctor',
        status: 'unchecked',
        reason:
          'This DSH adapter has no native machine-readable health report. Configuration composition does not validate runtime model routes or stored credentials.',
      },
      modelAccess,
    ],
  };
}

async function checkDshProfile(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<void> {
  const stdout = await runNativeAgentCommand(
    context,
    'dsh',
    ['--profile', 'headless', '--dump-config'],
    signal,
  );
  // Keep native expressions inert, and never include dump values or parser errors in diagnostics.
  const document = parseDocument(stdout, { logLevel: 'silent' });
  if (document.errors.length)
    throw new Error(
      'DSH returned invalid headless configuration. Check agent.dsh executable and repair the native headless profile.',
    );
  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    throw new Error(
      'DSH returned unsupported headless configuration. Check agent.dsh executable and repair the native headless profile.',
    );
  }
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(
      'DSH returned an empty or unsupported headless configuration. Check agent.dsh executable and repair the native headless profile.',
    );
}
