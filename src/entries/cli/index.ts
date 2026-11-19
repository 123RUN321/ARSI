import { errorText } from '../../shared/errors.js';
import type { Runtime } from '../../runtime/context.js';
import {
  CommandUsageError,
  runCommand,
  type CommandContext,
} from './commands.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let runtime: Runtime | undefined;
  let exitCode = 0;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Interrupted'));
  const disposeRuntime: CommandContext['disposeRuntime'] = async () => {
    const current = runtime;
    runtime = undefined;
    try {
      await current?.dispose();
      return { exitCode: 0 };
    } catch (error) {
      return { exitCode: 1, error };
    }
  };
  // Keep the listeners installed during dispatch so signal-exit lets cleanup run.
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const result = await runCommand(argv, {
      signal: controller.signal,
      async openRuntime(pluginDirectories) {
        const { createRuntime } = await import('../../runtime/context.js');
        runtime = await createRuntime({ pluginDirectories });
        return runtime;
      },
      disposeRuntime,
    });
    if (result.stdout !== undefined) process.stdout.write(result.stdout);
    exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof CommandUsageError) {
      process.stderr.write(error.helpText);
      exitCode = 2;
    } else {
      process.stderr.write(errorText(error) + '\n');
      exitCode = controller.signal.aborted ? 130 : 1;
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    const cleanup = await disposeRuntime();
    if (cleanup.exitCode === 1)
      process.stderr.write(
        `Failed to dispose runtime: ${errorText(cleanup.error)}\n`,
      );
    exitCode ||= cleanup.exitCode;
  }
  return exitCode;
}
