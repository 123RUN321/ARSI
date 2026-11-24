import type { DoctorResult, DoctorStep } from '../../contracts/index.js';
import { runDoctorProbe } from '../../shared/doctor-check.js';
import { errorText } from '../../shared/errors.js';

export async function runDoctorSteps(
  steps: DoctorStep[],
  signal: AbortSignal,
): Promise<DoctorResult> {
  if (!Array.isArray(steps))
    throw new Error('Doctor must return an array of check definitions.');
  const ids = new Set<string>();
  for (const step of steps) {
    if (
      !step ||
      typeof step !== 'object' ||
      typeof step.id !== 'string' ||
      !step.id ||
      ids.has(step.id)
    )
      throw new Error('Doctor check IDs must be nonempty and unique.');
    if (
      Object.keys(step).some(
        (key) =>
          !['id', 'check', 'reason', 'details', 'timeoutMs'].includes(key),
      )
    )
      throw new Error(`Doctor ${step.id} has an unsupported definition field.`);
    if (step.check !== undefined && typeof step.check !== 'function')
      throw new Error(`Doctor ${step.id}.check must be a function.`);
    if (
      step.timeoutMs !== undefined &&
      step.timeoutMs !== null &&
      (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)
    )
      throw new Error(`Doctor ${step.id}.timeoutMs must be positive.`);
    ids.add(step.id);
  }
  const checks: DoctorResult['checks'] = [];
  let failure: string | undefined;
  for (const step of steps) {
    signal.throwIfAborted();
    if (failure) {
      checks.push({
        id: step.id,
        status: 'unchecked',
        reason: `Not executed because ${failure} failed. Fix that failure and rerun doctor.`,
      });
      continue;
    }
    if (typeof step.reason !== 'string')
      throw new Error(`Doctor ${step.id}.reason must be a string.`);
    const check = step.check;
    if (!check) {
      checks.push({
        id: step.id,
        status: 'unchecked',
        reason: step.reason,
        ...(step.details ? { details: step.details } : {}),
      });
      continue;
    }
    const requireBoolean = (value: unknown): boolean => {
      if (typeof value !== 'boolean')
        throw new Error(`${step.id}.check must return a boolean.`);
      return value;
    };
    const execute = (bounded: AbortSignal): boolean | Promise<boolean> => {
      const result = check(bounded);
      return typeof result === 'boolean'
        ? result
        : Promise.resolve(result).then(requireBoolean);
    };
    const result =
      step.timeoutMs === null
        ? await Promise.resolve()
            .then(() => execute(signal))
            .then(
              (value) => ({ value, reason: undefined }),
              (error: unknown) => {
                signal.throwIfAborted();
                return { value: undefined, reason: errorText(error) };
              },
            )
        : await runDoctorProbe(step.id, execute, {
            signal,
            timeoutMs: step.timeoutMs,
          }).then(({ value, check }) => ({ value, reason: check.reason }));
    signal.throwIfAborted();
    if (result.value !== true) failure = step.id;
    checks.push({
      id: step.id,
      status: result.value === true ? 'passed' : 'failed',
      ...(result.value !== true
        ? { reason: [step.reason, result.reason].filter(Boolean).join(' ') }
        : {}),
      ...(step.details ? { details: step.details } : {}),
    });
  }
  return { checks };
}
