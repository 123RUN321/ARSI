#!/usr/bin/env node
import { constants } from 'node:os';
import {
  errorText,
  RuntimeCleanupInterruptedError,
} from '../../shared/errors.js';
import { CommandUsageError, runCommand } from './commands.js';
import { createCommandContext, writeRuntimeCleanupError } from './runtime.js';

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
    if (error instanceof CommandUsageError) {
      process.stderr.write(error.helpText);
      exitCode = 2;
    } else {
      const interruptedCleanup =
        error instanceof RuntimeCleanupInterruptedError;
      process.stderr.write(
        errorText(interruptedCleanup ? error.interruption : error) + '\n',
      );
      if (interruptedCleanup) writeRuntimeCleanupError(error.cause);
      exitCode = controller.signal.aborted ? 130 : 1;
    }
  } finally {
    const cleanupExitCode = await context.disposeRuntime().finally(() => {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    });
    exitCode ||= cleanupExitCode;
  }
  return exitCode;
}

process.exitCode = await main(process.argv.slice(2));
