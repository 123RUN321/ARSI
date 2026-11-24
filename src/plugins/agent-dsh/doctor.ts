import type { DoctorContext, DoctorStep } from '../../contracts/index.js';
import { parseDocument } from 'yaml';
import {
  isNativeAgentCompatible,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export function checkDshAgent(context: DoctorContext): DoctorStep[] {
  const isExecutableCompatible = (signal: AbortSignal): Promise<boolean> =>
    isNativeAgentCompatible(
      context,
      'dsh',
      ['--profile', 'headless', '--help'],
      ['--json', '--permission-mode', '--approval-policy'],
      signal,
    );
  const isProfileValid = (signal: AbortSignal): Promise<boolean> =>
    isDshProfileValid(context, signal);

  return [
    {
      id: 'executable',
      check: isExecutableCompatible,
      reason: `The CLI lacks required CLI options. Check ${context.binding.name}.config.executable and upgrade the native CLI.`,
    },
    {
      id: 'profile-config',
      check: isProfileValid,
      reason:
        'DSH returned invalid or unsupported headless configuration. Check executable and repair the native headless profile.',
    },
    {
      id: 'doctor',
      reason:
        'This DSH adapter has no native machine-readable health report. Configuration composition does not validate runtime model routes or stored credentials.',
    },
    {
      id: 'model-access',
      reason:
        'Native preflight does not establish model-service reachability or model availability. Verify model access in the native client before running RSI.',
    },
  ];
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
