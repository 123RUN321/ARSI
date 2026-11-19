import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Runtime } from '../../runtime/context.js';
import { errorText } from '../../shared/errors.js';

export interface CommandContext {
  signal: AbortSignal;
  openRuntime(pluginDirectories: string[]): Promise<Runtime>;
  disposeRuntime(options?: {
    reportToStderr?: boolean;
  }): Promise<{ exitCode: 0 } | { exitCode: 1; error: unknown }>;
}

export function createCommandContext(signal: AbortSignal): CommandContext {
  let runtime: Runtime | undefined;
  return {
    signal,
    async openRuntime(pluginDirectories) {
      const { createRuntime } = await import('../../runtime/context.js');
      runtime = await createRuntime({ pluginDirectories });
      return runtime;
    },
    async disposeRuntime({ reportToStderr = true } = {}) {
      const current = runtime;
      runtime = undefined;
      try {
        await current?.dispose();
        return { exitCode: 0 };
      } catch (error) {
        if (reportToStderr)
          process.stderr.write(
            `Failed to dispose runtime: ${errorText(error)}\n`,
          );
        return { exitCode: 1, error };
      }
    },
  };
}

export async function ensurePluginHome(): Promise<void> {
  await mkdir(join(homedir(), '.arsi', 'plugins'), { recursive: true });
}

export async function withRuntime(
  openRuntime: CommandContext['openRuntime'],
  pluginDirectories: string[],
  execute: (runtime: Runtime) => unknown,
): Promise<unknown> {
  await ensurePluginHome();
  return execute(await openRuntime(pluginDirectories));
}
