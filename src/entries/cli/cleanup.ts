import type { FactStore } from '../../contracts/index.js';
import {
  runEvaluatorCleanup,
  type CleanupReceiptResult,
} from '../../plugins/shared/evaluator-adapter/cleanup.js';
import type { Manager } from '../../runtime/manager/index.js';
import { acquireExecutionLock } from '../../runtime/manager/execution-lock.js';
import { readExperimentRecord } from '../../runtime/manager/records.js';
import { acquireResourceGate } from '../../runtime/revisions/exclusion.js';
import { FileFacts, safeId } from '../../runtime/storage/index.js';
import { errorText } from '../../shared/errors.js';
import { string } from '../../shared/json.js';

class ExperimentInUseError extends Error {}

interface ExperimentCleanupReport {
  experimentId: string;
  dryRun: boolean;
  results: CleanupReceiptResult[];
}

type WorkspaceCleanupEntry = Pick<
  ExperimentCleanupReport,
  'experimentId' | 'results'
> &
  (
    | { status: 'complete' | 'pending' | 'preview' }
    | { status: 'skipped' | 'interrupted'; reason: string }
    | { status: 'failed'; error: string }
  );

/** Preview saved inputs at any time. Execution holds the same ownership lock as run and resume. */
async function collectExperimentCleanup(
  manager: Manager,
  { experimentId, dryRun, results }: ExperimentCleanupReport,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const experiment = readExperimentRecord(
    await manager.get(safeId(experimentId)),
  );
  if (experiment.id !== experimentId)
    throw new Error('Experiment identity mismatch');
  signal.throwIfAborted();
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
          throw new ExperimentInUseError(
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
  } finally {
    await release?.();
  }
}

export async function cleanupExperiment(
  manager: Manager,
  experimentId: string,
  dryRun: boolean,
  signal: AbortSignal,
): Promise<ExperimentCleanupReport> {
  const report: ExperimentCleanupReport = { experimentId, dryRun, results: [] };
  await collectExperimentCleanup(manager, report, signal);
  return report;
}

/** Inspect each experiment independently so a busy or damaged one cannot block its peers. */
export async function cleanupWorkspace(
  manager: Manager,
  dryRun: boolean,
  signal: AbortSignal,
): Promise<{ dryRun: boolean; experiments: WorkspaceCleanupEntry[] }> {
  const experiments: WorkspaceCleanupEntry[] = [];
  const ids =
    manager.facts instanceof FileFacts
      ? await manager.facts.listIds('experiments')
      : (await manager.list()).map((record) =>
          string(record.id, 'experiment ID'),
        );
  for (const experimentId of ids) {
    if (signal.aborted) break;
    const results: CleanupReceiptResult[] = [];
    const entry = { experimentId, results };
    try {
      await collectExperimentCleanup(manager, { ...entry, dryRun }, signal);
      signal.throwIfAborted();
      const status = results.some((entry) => entry.status === 'pending')
        ? 'pending'
        : dryRun
          ? 'preview'
          : 'complete';
      experiments.push({ ...entry, status });
    } catch (error) {
      if (signal.aborted)
        experiments.push({
          ...entry,
          status: 'interrupted',
          reason: errorText(signal.reason),
        });
      else if (error instanceof ExperimentInUseError)
        experiments.push({
          ...entry,
          status: 'skipped',
          reason: error.message,
        });
      else
        experiments.push({
          ...entry,
          status: 'failed',
          error: errorText(error),
        });
    }
  }
  return { dryRun, experiments };
}
