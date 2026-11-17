import { join } from 'node:path';
import { check } from 'proper-lockfile';
import { safeId } from '../storage/index.js';

/** Lock acquisition and read-only observation must use the same heartbeat window. */
export const executionLockTiming = { stale: 60_000, update: 10_000 };

export function executionLockPath(directory: string, id: string): string {
  return join(directory, 'locks', safeId(id));
}

/** A fresh lock confirms Runtime ownership, not model progress or task health. */
export async function executionStatus(
  directory: string | undefined,
  id: string,
): Promise<'active' | 'unconfirmed'> {
  if (!directory) return 'unconfirmed';
  try {
    return (await check(executionLockPath(directory, id), {
      realpath: false,
      stale: executionLockTiming.stale,
    }))
      ? 'active'
      : 'unconfirmed';
  } catch {
    // An unreadable lock cannot establish that an execution owner is alive.
    return 'unconfirmed';
  }
}
