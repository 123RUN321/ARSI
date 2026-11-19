#!/usr/bin/env node
import { constants } from 'node:os';
import type { Runtime } from '../../runtime/context.js';
import {
  errorText,
  RuntimeCleanupInterruptedError,
} from '../../shared/errors.js';
import { runCommand, type CommandContext } from './commands.js';

async function main(argv: string[]): Promise<number> {
  let exitCode = 0;
  const controller = new AbortController();
  const context = createCommandContext(controller.signal);
  const abort = (signal: NodeJS.Signals = 'SIGINT'): void => {
    if (controller.signal.aborted)
      process.exit(128 + constants.signals[signal]);
    controller.abort(new Error('Interrupted'));
  };
  // Keep the listeners installed during dispatch so signal-exit lets cleanup run.
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const result = await runCommand(argv, context);
    if (result.stdout !== undefined) process.stdout.write(result.stdout);
    exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof RuntimeCleanupInterruptedError) {
      process.stderr.write(errorText(error.interruption) + '\n');
      writeRuntimeCleanupError(error.cause);
    } else {
      process.stderr.write(errorText(error) + '\n');
    }
    exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    const cleanupExitCode = await context.disposeRuntime().finally(() => {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    });
    exitCode ||= cleanupExitCode;
  }
  return exitCode;
}

function createCommandContext(
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
        writeRuntimeCleanupError(error);
        return 1;
      }
    },
  };
}

function writeRuntimeCleanupError(error: unknown): void {
  process.stderr.write(`Failed to dispose runtime: ${errorText(error)}\n`);
}

process.exitCode = await main(process.argv.slice(2));
