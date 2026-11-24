import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import { object } from '../../shared/json.js';
import {
  checkNativeAgentExecutable,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkClaudeCodeAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const executable = await checkNativeAgentExecutable(
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
  );
  const modelAccess: DoctorResult['checks'][number] = {
    id: 'model-access',
    status: 'unchecked',
    reason:
      'Native preflight does not establish model-service reachability or model availability. Verify model access in the native client before running RSI.',
  };
  if (executable.status !== 'passed')
    return { checks: [executable, modelAccess] };
  const authentication = await runDoctorCheck(
    'authentication',
    (signal) => checkClaudeAuthentication(context, signal),
    { signal: context.signal },
  );
  return {
    checks: [
      executable,
      {
        id: 'doctor',
        status: 'unchecked',
        reason:
          'Claude Code doctor exposes text diagnostics without a machine-readable health report; run claude doctor for installation details.',
      },
      authentication,
      modelAccess,
    ],
  };
}

async function checkClaudeAuthentication(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<void> {
  const help = await runNativeAgentCommand(
    context,
    'claude',
    ['auth', 'status', '--help'],
    signal,
  );
  if (!/(?:^|\s)--json(?:\s|$)/m.test(help))
    throw new Error(
      'Claude Code does not advertise JSON authentication status; upgrade the CLI.',
    );
  const stdout = await runNativeAgentCommand(
    context,
    'claude',
    ['auth', 'status', '--json'],
    signal,
    [0, 1],
  );
  let loggedIn: unknown;
  try {
    loggedIn = object(JSON.parse(stdout)).loggedIn;
  } catch {
    throw new Error('Claude Code returned invalid authentication status.');
  }
  if (typeof loggedIn !== 'boolean')
    throw new Error('Claude Code returned unsupported authentication status.');
  if (!loggedIn)
    throw new Error(
      'Claude Code has no active authentication; configure authentication in the native CLI.',
    );
}
