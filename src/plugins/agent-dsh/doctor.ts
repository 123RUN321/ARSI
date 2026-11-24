import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { parseDocument } from 'yaml';
import { failed, passed, runDoctorProbe } from '../../shared/doctor-check.js';
import {
  isNativeAgentCompatible,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkDshAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const executable = await runDoctorProbe(
    'executable',
    (signal) =>
      isNativeAgentCompatible(
        context,
        'dsh',
        ['--profile', 'headless', '--help'],
        ['--json', '--permission-mode', '--approval-policy'],
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
  const profile = await runDoctorProbe(
    'profile-config',
    (signal) => isDshProfileValid(context, signal),
    { signal: context.signal },
  );
  if (!profile.value)
    return failed(
      'profile-config',
      profile.check.reason ??
        'DSH returned invalid or unsupported headless configuration. Check executable and repair the native headless profile.',
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

async function isDshProfileValid(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<boolean> {
  const stdout = await runNativeAgentCommand(
    context,
    'dsh',
    ['--profile', 'headless', '--dump-config'],
    signal,
  );
  // Keep native expressions inert, and never include dump values or parser errors in diagnostics.
  const document = parseDocument(stdout, { logLevel: 'silent' });
  if (document.errors.length) return false;
  try {
    const value: unknown = document.toJS();
    return Array.isArray(value) && value.length > 0;
  } catch {
    return false;
  }
}
