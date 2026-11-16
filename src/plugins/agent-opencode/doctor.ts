import { object } from '../../shared/json.js';
import { launchEnvironment } from './session.js';
import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import {
  checkNativeAgent,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkOpenCodeAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const result = await checkNativeAgent(
    context,
    'opencode',
    ['run', '--help'],
    ['--standalone', '--format', '--model', '--archived'],
  );
  if (result.checks[0].status !== 'passed') return result;
  result.checks.splice(
    1,
    0,
    await runDoctorCheck(
      'version',
      async (signal) => {
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
      },
      { signal: context.signal },
    ),
  );
  if (result.checks[1].status !== 'passed') return result;
  result.checks.splice(
    2,
    0,
    await runDoctorCheck(
      'configuration',
      async (signal) => {
        const stdout = await runNativeAgentCommand(
          context,
          'opencode',
          ['debug', 'config', '--standalone'],
          signal,
          [0],
          launchEnvironment(context.directory),
        );
        try {
          const entries: unknown = JSON.parse(stdout);
          if (
            !Array.isArray(entries) ||
            !entries.some((entry: unknown) => object(entry).info !== undefined)
          )
            throw new Error('missing native configuration');
        } catch {
          throw new Error('OpenCode could not load its native configuration.');
        }
      },
      { signal: context.signal },
    ),
  );
  return result;
}
