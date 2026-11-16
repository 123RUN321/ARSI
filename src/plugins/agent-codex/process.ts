import { nativeAgentCommand } from '../shared/native-agent/executable.js';
import type {
  AgentProcessLauncher,
  AgentLineHandler,
} from '../../contracts/index.js';
import { codexCommand } from './executable.js';
export async function runCodexProcess(
  executable: string,
  input: string,
  onLine: AgentLineHandler,
  launch: AgentProcessLauncher,
  config: string[] = [],
): Promise<void> {
  const command = codexCommand(executable);
  const native = await nativeAgentCommand(command.executable);
  await launch(
    {
      executable: native.command,
      args: [
        ...native.args,
        ...command.args,
        ...config.flatMap((value) => ['-c', value]),
        'app-server',
      ],
      input,
      interactive: true,
    },
    onLine,
  );
}
