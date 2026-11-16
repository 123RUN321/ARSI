import type { AgentProcessLauncher } from '../../../contracts/index.js';
import { nativeAgentCommand } from './executable.js';

export async function runNativeJsonProcess(
  executable: string,
  args: string[],
  input: string,
  onLine: (line: string) => void,
  launch: AgentProcessLauncher,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const command = await nativeAgentCommand(executable);
  await launch(
    {
      executable: command.command,
      args: [...command.args, ...args],
      input,
      ...(env ? { env } : {}),
    },
    onLine,
  );
}
