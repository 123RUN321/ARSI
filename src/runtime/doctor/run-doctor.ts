import type { DoctorReport } from '../../contracts/index.js';
import { RuntimeCleanupInterruptedError } from '../../shared/errors.js';
import type { Runtime } from '../context.js';
import { doctorRecipe } from './index.js';
import { createFailureReport } from './report.js';

/** The caller owns the Runtime if diagnosis throws before releasing it. */
export async function runDoctor(
  recipePath: string,
  {
    signal,
    openRuntime,
    releaseRuntime,
  }: {
    signal: AbortSignal;
    openRuntime(): Promise<Runtime>;
    releaseRuntime(): Promise<void>;
  },
): Promise<DoctorReport> {
  let runtime: Runtime;
  try {
    runtime = await openRuntime();
  } catch (error) {
    signal.throwIfAborted();
    return createFailureReport('runtime.registration', error);
  }

  const report = await doctorRecipe(runtime, recipePath, { signal }).catch(
    (error: unknown) => {
      signal.throwIfAborted();
      return createFailureReport('doctor.runtime', error);
    },
  );
  try {
    await releaseRuntime();
  } catch (error) {
    if (signal.aborted)
      throw new RuntimeCleanupInterruptedError(signal.reason, error);
    const cleanupReport = createFailureReport('runtime.cleanup', error);
    report.checks.push(...cleanupReport.checks);
  }
  signal.throwIfAborted();
  return report;
}
