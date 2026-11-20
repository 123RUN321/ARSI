import { setTimeout as delay } from 'node:timers/promises';

const transientCodes = new Set([
  'EAGAIN',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'ETXTBSY',
]);

export async function retryStartup<T>(
  signal: AbortSignal,
  start: () => Promise<T>,
  retryable = (error: Error) =>
    'code' in error && transientCodes.has(String(error.code)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await start();
    } catch (error) {
      signal.throwIfAborted();
      if (attempt >= 2 || !(error instanceof Error) || !retryable(error))
        throw error;
      await delay(250 * (attempt + 1), undefined, { signal });
    }
  }
}
