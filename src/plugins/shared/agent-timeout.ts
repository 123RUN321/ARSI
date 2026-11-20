import type { JsonValue, Operation } from '../../contracts/index.js';

/** Built-in backends retain their existing timeout configuration fields. */
export function withAgentExecutionTimeout<
  I extends JsonValue,
  O extends JsonValue,
>(operation: Operation<I, O>, timeoutMs: number | undefined): Operation<I, O> {
  if (timeoutMs === undefined) return operation;
  return {
    async execute(input, context) {
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const timer = setTimeout(
        () => controller.abort(new Error('Agent execution timed out')),
        timeoutMs,
      );
      try {
        const output = await operation.execute(
          input,
          context.extend({ signal }),
        );
        signal.throwIfAborted();
        return output;
      } finally {
        clearTimeout(timer);
      }
    },
    dispose: () => operation.dispose(),
  };
}
