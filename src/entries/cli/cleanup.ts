import type { FactStore } from '../../contracts/index.js';
import {
  runEvaluatorCleanup,
  type CleanupReceiptResult,
} from '../../plugins/shared/evaluator-adapter/cleanup.js';
import type { Manager } from '../../runtime/manager/index.js';
import { acquireExecutionLock } from '../../runtime/manager/execution-lock.js';
import { readExperimentRecord } from '../../runtime/manager/records.js';
import { acquireResourceGate } from '../../runtime/revisions/exclusion.js';
import { safeId } from '../../runtime/storage/index.js';

/** Preview saved inputs at any time. Execution holds the same ownership lock as run and resume. */
export async function cleanupExperiment(
  manager: Manager,
  experimentId: string,
  dryRun: boolean,
  signal: AbortSignal,
): Promise<{
  experimentId: string;
  dryRun: boolean;
  results: CleanupReceiptResult[];
}> {
  signal.throwIfAborted();
  const experiment = readExperimentRecord(
    await manager.get(safeId(experimentId)),
  );
  if (experiment.id !== experimentId)
    throw new Error('Experiment identity mismatch');
  const ownership = new AbortController();
  let release: (() => Promise<void>) | undefined;
  try {
    if (!dryRun) {
      const gate = await acquireResourceGate(manager.directory);
      try {
        release = await acquireExecutionLock(
          manager.directory,
          experimentId,
          gate,
          ownership,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ELOCKED'
        )
          throw new Error(
            `Experiment ${experimentId} is in use. Preview with --dry-run or retry after it finishes.`,
          );
        throw error;
      } finally {
        await gate.release();
      }
    }
    const cleanupSignal = AbortSignal.any([signal, ownership.signal]);
    cleanupSignal.throwIfAborted();
    const store = manager.facts;
    const facts: FactStore = {
      read: store.read.bind(store),
      list: store.list.bind(store),
      scan: store.scan?.bind(store),
      write(kind, id, value) {
        ownership.signal.throwIfAborted();
        return store.write(kind, id, value);
      },
    };
    const results: CleanupReceiptResult[] = [];
    await runEvaluatorCleanup(
      {
        experimentId,
        dataDirectory: manager.directory,
        facts,
        signal: cleanupSignal,
      },
      { dryRun, onResult: (result) => results.push(result) },
    );
    ownership.signal.throwIfAborted();
    return { experimentId, dryRun, results };
  } finally {
    await release?.();
  }
}
