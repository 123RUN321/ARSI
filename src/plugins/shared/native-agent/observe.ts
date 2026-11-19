import type { AgentObservation, JsonValue } from '../../../contracts/index.js';

/** Protocol detail decoding may fail independently of task/result decoding. */
export function observeNative<T extends (JsonValue | object)[]>(
  observe: (...args: T) => void,
  record: (event: AgentObservation) => void,
  signal: AbortSignal,
): (...args: T) => void {
  return (...args) => {
    try {
      observe(...args);
    } catch (error) {
      // Preserve explicit execution cancellation while isolating decoder failures.
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
