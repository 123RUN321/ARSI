#!/usr/bin/env node
import { errorText } from '../../shared/errors.js';
import { CommandUsageError, runCommand } from './commands.js';
import { createCommandContext } from './runtime.js';

let exitCode = 0;
const controller = new AbortController();
const context = createCommandContext(controller.signal);
const abort = (): void => controller.abort(new Error('Interrupted'));
// Keep the listeners installed during dispatch so signal-exit lets cleanup run.
process.on('SIGINT', abort);
process.on('SIGTERM', abort);
try {
  const result = await runCommand(process.argv.slice(2), context);
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
  const cleanup = await context.disposeRuntime();
  exitCode ||= cleanup.exitCode;
}
process.exitCode = exitCode;
