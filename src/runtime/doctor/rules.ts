import type { DoctorResult, DoctorRule } from '../../contracts/index.js';
import { runDoctorProbe } from '../../shared/doctor-check.js';
import { errorText } from '../../shared/errors.js';

export async function runDoctorRules(
  rules: DoctorRule[],
  signal: AbortSignal,
): Promise<DoctorResult> {
  if (!Array.isArray(rules))
    throw new Error('Doctor must return an array of check definitions.');
  const ids = new Set<string>();
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule !== 'object' ||
      typeof rule.id !== 'string' ||
      !rule.id ||
      ids.has(rule.id)
    )
      throw new Error('Doctor check IDs must be nonempty and unique.');
    if (
      Object.keys(rule).some(
        (key) =>
          !['id', 'check', 'reason', 'details', 'timeoutMs'].includes(key),
      )
    )
      throw new Error(`Doctor ${rule.id} has an unsupported definition field.`);
    if (rule.check !== undefined && typeof rule.check !== 'function')
      throw new Error(`Doctor ${rule.id}.check must be a function.`);
    if (
      rule.timeoutMs !== undefined &&
      rule.timeoutMs !== null &&
      (!Number.isFinite(rule.timeoutMs) || rule.timeoutMs <= 0)
    )
      throw new Error(`Doctor ${rule.id}.timeoutMs must be positive.`);
    ids.add(rule.id);
  }
  const checks: DoctorResult['checks'] = [];
  let failure: string | undefined;
  for (const rule of rules) {
    signal.throwIfAborted();
    if (failure) {
      checks.push({
        id: rule.id,
        status: 'unchecked',
        reason: `Not executed because ${failure} failed. Fix that failure and rerun doctor.`,
      });
      continue;
    }
    if (typeof rule.reason !== 'string')
      throw new Error(`Doctor ${rule.id}.reason must be a string.`);
    const check = rule.check;
    if (!check) {
      checks.push({
        id: rule.id,
        status: 'unchecked',
        reason: rule.reason,
        ...(rule.details ? { details: rule.details } : {}),
      });
      continue;
    }
    const requireBoolean = (value: unknown): boolean => {
      if (typeof value !== 'boolean')
        throw new Error(`${rule.id}.check must return a boolean.`);
      return value;
    };
    const execute = (bounded: AbortSignal): boolean | Promise<boolean> => {
      const result = check(bounded);
      return typeof result === 'boolean'
        ? result
        : Promise.resolve(result).then(requireBoolean);
    };
    const result =
      rule.timeoutMs === null
        ? await Promise.resolve()
            .then(() => execute(signal))
            .then(
              (value) => ({ value, reason: undefined }),
              (error: unknown) => {
                signal.throwIfAborted();
                return { value: undefined, reason: errorText(error) };
              },
            )
        : await runDoctorProbe(rule.id, execute, {
            signal,
            timeoutMs: rule.timeoutMs,
          }).then(({ value, check }) => ({ value, reason: check.reason }));
    signal.throwIfAborted();
    if (result.value !== true) failure = rule.id;
    checks.push({
      id: rule.id,
      status: result.value === true ? 'passed' : 'failed',
      ...(result.value !== true
        ? { reason: [rule.reason, result.reason].filter(Boolean).join(' ') }
        : {}),
      ...(rule.details ? { details: rule.details } : {}),
    });
  }
  return { checks };
}
