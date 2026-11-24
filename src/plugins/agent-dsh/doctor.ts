import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { parseDocument } from 'yaml';
import { runDoctorCheck } from '../../shared/doctor-check.js';
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
  const modelAccess: DoctorResult['checks'][number] = {
    id: 'model-access',
    status: 'unchecked',
    reason:
      'Native preflight does not establish model-service reachability or model availability. Verify model access in the native client before running RSI.',
  };
  if (executable.status !== 'passed')
    return { checks: [executable, modelAccess] };
  const profile = await runDoctorCheck(
    'profile-config',
    (signal) => checkDshProfile(context, signal),
    { signal: context.signal },
  );
  return {
    checks: [
      executable,
      profile,
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
    throw new Error('DSH returned invalid headless configuration.');
  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    throw new Error('DSH returned unsupported headless configuration.');
  }
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(
      'DSH returned an empty or unsupported headless configuration.',
    );
}
