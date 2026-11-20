import type { AgentProcessLauncher } from '../../contracts/index.js';
import { runNativeJsonProcess } from '../shared/native-agent/json-process.js';
export async function runDshProcess(
  executable: string,
  patch: string,
  prompt: string,
  onLine: (line: string) => void,
  launch: AgentProcessLauncher,
): Promise<void> {
  await runNativeJsonProcess(
    executable,
    ['--profile', 'headless', '--patch', patch, '--json', '-'],
    prompt,
    onLine,
    launch,
  );
}
