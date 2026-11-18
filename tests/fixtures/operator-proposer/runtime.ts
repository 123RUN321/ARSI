import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { EmbeddingConfig } from '../../../src/plugins/proposer-operator/schema.js';

const execute = promisify(execFile);

// The synthetic worker has no descendants. POSIX process-group behavior is
// covered separately by the real retrieval worker tests.
export async function runRetrievalWorker(
  config: EmbeddingConfig,
  args: string[],
  cwd: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  if (
    config.python !== process.execPath ||
    basename(args[0] ?? '') !== 'embedding-worker.mjs'
  )
    throw new Error('Expected the synthetic Operator embedding worker');
  const worker = execute(config.python, args, {
    cwd,
    signal,
    timeout: config.timeoutMs,
  });
  const { stdout, stderr } = await worker;
  await Promise.all([
    writeFile(join(directory, 'stdout.log'), stdout),
    writeFile(join(directory, 'stderr.log'), stderr),
    writeFile(
      join(directory, 'process.json'),
      JSON.stringify({
        pid: worker.child.pid,
        exitCode: 0,
        cleanup: 'confirmed',
        error: null,
      }) + '\n',
    ),
  ]);
}

async function importOperatorRuntime() {
  const { createRuntime } = await import('../../../src/runtime/context.js');
  const { createOperatorProposer } = await import(
    '../../../src/plugins/proposer-operator/service.js'
  );
  return { createRuntime, createOperatorProposer };
}

type OperatorTestRuntime = ReturnType<typeof importOperatorRuntime>;

let runtime: OperatorTestRuntime | undefined;

/** Use the synthetic worker transport only in Windows orchestration tests. */
export function loadOperatorRuntime(): OperatorTestRuntime {
  return (runtime ??= initializeOperatorRuntime());
}

async function initializeOperatorRuntime(): OperatorTestRuntime {
  if (process.platform !== 'win32') return importOperatorRuntime();
  const workerUrl = new URL(
    '../../../src/plugins/proposer-operator/retrieval-worker.ts',
    import.meta.url,
  ).href;
  let installed = false;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url !== workerUrl) return resolved;
      installed = true;
      return nextResolve(import.meta.url, context);
    },
  });
  try {
    const loaded = await importOperatorRuntime();
    if (!installed)
      throw new Error(
        'Load the Operator test runtime before importing it directly',
      );
    return loaded;
  } finally {
    hook.deregister();
  }
}
