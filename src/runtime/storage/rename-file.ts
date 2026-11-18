import { rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const retryDelaysMs = [10, 20, 40, 80, 160, 320];

/** Retry file replacement when another process may be holding a handle. */
export async function renameFileWithRetry(
  source: string,
  destination: string,
  beforeAttempt?: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await beforeAttempt?.();
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (
        delay === undefined ||
        !(error instanceof Error) ||
        !('code' in error) ||
        (error.code !== 'EPERM' && error.code !== 'EBUSY')
      )
        throw error;
      await setTimeout(delay);
    }
  }
}
