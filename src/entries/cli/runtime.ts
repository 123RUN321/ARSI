import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Runtime } from '../../runtime/context.js';
import { errorText } from '../../shared/errors.js';

export interface CommandContext {
  signal: AbortSignal;
  openRuntime(pluginDirectories: string[]): Promise<Runtime>;
  releaseRuntime(): Promise<void>;
}

export function createCommandContext(
  signal: AbortSignal,
): CommandContext & { disposeRuntime(): Promise<0 | 1> } {
  let runtime: Runtime | undefined;
  async function releaseRuntime(): Promise<void> {
    const current = runtime;
    runtime = undefined;
    await current?.dispose();
  }

  return {
    signal,
    async openRuntime(pluginDirectories) {
      const { createRuntime } = await import('../../runtime/context.js');
      runtime = await createRuntime({ pluginDirectories });
      return runtime;
    },
    releaseRuntime,
    async disposeRuntime() {
      try {
        await releaseRuntime();
        return 0;
      } catch (error) {
        process.stderr.write(
          `Failed to dispose runtime: ${errorText(error)}\n`,
        );
        return 1;
      }
    },
  };
}

export async function ensurePluginHome(): Promise<void> {
  await mkdir(join(homedir(), '.arsi', 'plugins'), { recursive: true });
}
