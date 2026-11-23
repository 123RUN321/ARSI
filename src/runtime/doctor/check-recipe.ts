import type { DoctorReport } from '../../contracts/index.js';
import { RuntimeCleanupInterruptedError } from '../../shared/errors.js';
import type { Runtime } from '../context.js';
import { doctorFailure, doctorRecipe } from './index.js';

/** The caller owns the Runtime if diagnosis throws before releasing it. */
export async function checkRecipe(
  file: string,
  {
    signal,
    staticOnly,
    openRuntime,
    releaseRuntime,
  }: {
    signal: AbortSignal;
    staticOnly: boolean;
    openRuntime(): Promise<Runtime>;
    releaseRuntime(): Promise<void>;
  },
): Promise<DoctorReport> {
  let runtime: Runtime;
  try {
    runtime = await openRuntime();
  } catch (error) {
    signal.throwIfAborted();
    return doctorFailure('runtime.registration', error);
  }

  const report = await doctorRecipe(runtime, file, {
    signal,
    staticOnly,
  }).catch((error: unknown) => {
    signal.throwIfAborted();
    return doctorFailure('doctor.runtime', error);
  });
  try {
    await releaseRuntime();
  } catch (error) {
    if (signal.aborted)
      throw new RuntimeCleanupInterruptedError(signal.reason, error);
    const cleanup = doctorFailure('runtime.cleanup', error);
    report.checks.push(...cleanup.checks);
  }
  signal.throwIfAborted();
  return report;
}
