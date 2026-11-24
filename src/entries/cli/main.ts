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
    exitCode = failCommand(error, controller.signal.aborted);
  } finally {
    exitCode = await finishCommand(context, abort, exitCode);
  }
  return exitCode;
}

function createCommandContext(signal: AbortSignal): CommandContext {
  let runtime: Runtime | undefined;

  async function openRuntime(pluginDirectories: string[]): Promise<Runtime> {
    const { createRuntime } = await import('../../runtime/context.js');
    runtime = await createRuntime({ pluginDirectories });
    return runtime;
  }

  async function releaseRuntime(): Promise<void> {
    const current = runtime;
    runtime = undefined;
    await current?.dispose();
  }

  return { signal, openRuntime, releaseRuntime };
}

function failCommand(error: unknown, aborted: boolean): number {
  if (error instanceof RuntimeCleanupInterruptedError) {
    process.stderr.write(errorText(error.interruption) + '\n');
    process.stderr.write(
      `Failed to dispose runtime: ${errorText(error.cause)}\n`,
    );
  } else {
    process.stderr.write(errorText(error) + '\n');
  }
  return aborted ? 130 : 1;
}

async function finishCommand(
  context: CommandContext,
  abort: (signal?: NodeJS.Signals) => void,
  exitCode: number,
): Promise<number> {
  try {
    await context.releaseRuntime();
  } catch (error) {
    process.stderr.write(`Failed to dispose runtime: ${errorText(error)}\n`);
    exitCode ||= 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
  return exitCode;
}

process.exitCode = await main(process.argv.slice(2));
