import type { DoctorReport } from '../../contracts/index.js';
import type { Runtime } from '../../runtime/context.js';
import type { CommandContext } from './commands.js';

export async function checkRecipe(
  file: string,
  staticOnly: boolean,
  pluginDirectories: string[],
  { signal, openRuntime, disposeRuntime }: CommandContext,
): Promise<DoctorReport> {
  const { doctorRecipe, doctorFailure } = await import(
    '../../runtime/doctor/index.js'
  );
  let runtime: Runtime;
  try {
    runtime = await openRuntime(pluginDirectories);
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
  const disposal = await disposeRuntime();
  if (disposal.exitCode === 1) {
    signal.throwIfAborted();
    const cleanup = doctorFailure('runtime.cleanup', disposal.error);
    report.checks.push(...cleanup.checks);
    report.summary.failed += cleanup.summary.failed;
  }
  return report;
}
