import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { failed, passed, runDoctorProbe } from '../../shared/doctor-check.js';
import { object } from '../../shared/json.js';
import {
  isNativeAgentCompatible,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkClaudeCodeAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const executable = await runDoctorProbe(
    'executable',
    (signal) =>
      isNativeAgentCompatible(
        context,
        'claude',
        ['--help'],
        [
          '--print',
          '--output-format',
          '--json-schema',
          '--permission-mode',
          '--tools',
          '--permission-prompts',
          '--verbose',
          '--no-session-persistence',
          '--disallowedTools',
          '--mcp-config',
          '--settings',
          '--strict-mcp-config',
        ],
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
  const authentication = await runDoctorProbe(
    'authentication',
    (signal) => isClaudeAuthenticated(context, signal),
    { signal: context.signal },
  );
  if (!authentication.value)
    return failed(
      'authentication',
      authentication.check.reason ??
        'Claude Code has no valid authentication status. Check executable, upgrade the native CLI and configure authentication with claude auth login.',
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
      {
        id: 'doctor',
        status: 'unchecked',
        reason:
          'Claude Code doctor exposes text diagnostics without a machine-readable health report; run claude doctor for installation details.',
      },
      ...passed('authentication').checks,
      modelAccess,
    ],
  };
}

async function isClaudeAuthenticated(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<boolean> {
  const help = await runNativeAgentCommand(
    context,
    'claude',
    ['auth', 'status', '--help'],
    signal,
  );
  if (!/(?:^|\s)--json(?:\s|$)/m.test(help)) return false;
  const stdout = await runNativeAgentCommand(
    context,
    'claude',
    ['auth', 'status', '--json'],
    signal,
    [0, 1],
  );
  try {
    return object(JSON.parse(stdout)).loggedIn === true;
  } catch {
    return false;
  }
}
