import type { DoctorContext } from '../../../contracts/index.js';
import { string } from '../../../shared/json.js';
import { nativeAgentCommand } from '../native-agent/executable.js';
import { runCommand } from './process.js';

export async function isNativeAgentCompatible(
  context: DoctorContext,
  command: string,
  helpArgs: string[],
  requiredFlags: string[],
  signal: AbortSignal,
): Promise<boolean> {
  const stdout = await runNativeAgentCommand(
    context,
    command,
    helpArgs,
    signal,
  );
  return requiredFlags.every((flag) =>
    new RegExp(`(?:^|\\s|,)${flag}(?=[\\s,=]|$)`, 'm').test(stdout),
  );
}

/** Run another native preflight command with the same executable resolution. */
export async function runNativeAgentCommand(
  context: DoctorContext,
  command: string,
  args: string[],
  signal: AbortSignal,
  acceptedExitCodes: readonly number[] = [0],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const launch = await nativeAgentCommand(
      string(context.binding.config.executable ?? command),
    );
    const { stdout } = await runCommand(
      launch.command,
      [...launch.args, ...args],
      {
        signal,
        cwd: context.directory,
        acceptedExitCodes,
        env,
      },
    );
    return stdout;
  } catch {
    throw new Error(
      `${context.binding.pluginId} native preflight failed; check ${context.binding.name}.config.executable, the CLI installation, profile and credentials.`,
    );
  }
}
