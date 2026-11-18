import type { JsonObject } from '../../contracts/index.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import { validateSnapshot } from '../shared/evaluator-adapter/measurement.js';
import { strings } from '../../shared/json.js';

/** A benchmark-defined, non-retryable verifier timeout is failed measurement data,
 * never a valid zero score. Unconfirmed effects and infrastructure failures stay fatal. */
export function isFinalizedVerifierTimeout(
  result: JsonObject,
  ids: string[],
): boolean {
  const snapshot = plain(result.snapshot);
  const run = plain(snapshot.run);
  if (
    typeof result.exitCode !== 'number' ||
    result.exitCode === 0 ||
    run.status !== 'error' ||
    typeof run.finishedAt !== 'string' ||
    !run.finishedAt ||
    !ids.length ||
    !Array.isArray(snapshot.records) ||
    snapshot.records.length !== ids.length ||
    !Array.isArray(snapshot.pendingTaskIds) ||
    snapshot.pendingTaskIds.length
  )
    return false;
  try {
    validateSnapshot(snapshot);
    const selected = strings(run.taskIds);
    if (
      selected.length !== ids.length ||
      !ids.every((id) => selected.includes(id))
    )
      return false;
  } catch {
    return false;
  }
  return snapshot.records.every((raw) => {
    const record = plain(raw);
    return (
      record.executionStatus === 'failed' &&
      record.scoreStatus === 'invalid' &&
      record.cleanupStatus === 'cleaned' &&
      Array.isArray(record.errors) &&
      record.errors.length > 0 &&
      record.errors.every((rawError) => {
        const error = plain(rawError);
        return (
          error.code === 'VERIFY_TIMEOUT' &&
          error.phase === 'verify' &&
          error.category === 'verifier' &&
          error.scope === 'attempt' &&
          error.retryable === false &&
          error.action === 'finalize'
        );
      })
    );
  });
}
