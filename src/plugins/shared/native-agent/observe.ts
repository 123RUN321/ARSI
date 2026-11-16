import type { AgentObservation } from '../../../contracts/index.js';

/** Protocol detail decoding may fail independently of task/result decoding. */
export function observeNative<T extends unknown[]>(
  observe: (...args: T) => void,
  record: (event: AgentObservation) => void,
  signal: AbortSignal,
): (...args: T) => void {
  return (...args) => {
    try {
      observe(...args);
    } catch (error) {
      // Storage failure aborts the task synchronously and must never become a gap.
      signal.throwIfAborted();
      record({
        runId: 'main',
        event: {
          type: 'observation.gap',
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
}
