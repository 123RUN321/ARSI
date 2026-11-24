import type { DoctorResult, JsonObject } from '../contracts/index.js';
import { errorText } from './errors.js';

export function missingInputReason(
  field: string,
  kind: string,
  reference: string,
): string {
  return `Missing ${kind} ${reference}. Fix: Restore the ${kind} or correct ${field}.`;
}

export function missingInputError(
  {
    field,
    kind,
    reference,
  }: { field: string; kind: string; reference: string },
  cause: unknown,
): Error {
  return new Error(missingInputReason(field, kind, reference), { cause });
}

interface DoctorCheckOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  reason?: string;
  details?: JsonObject;
}

/** The action must release its work on cancellation. */
export async function runDoctorProbe<T>(
  id: string,
  action: (signal: AbortSignal) => T | Promise<T>,
  options: DoctorCheckOptions,
): Promise<{ check: DoctorResult['checks'][number]; value?: T }> {
  const { signal, timeoutMs = 60000, reason, details } = options;
  signal.throwIfAborted();
  const controller = new AbortController();
  const bounded = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `Probe timed out after ${timeoutMs} ms. Plugin availability is unknown.`,
        ),
      ),
    timeoutMs,
  );
  let abort: (() => void) | undefined;
  const job = Promise.resolve().then(() => {
    bounded.throwIfAborted();
    return action(bounded);
  });
  const check = { id, ...(details ? { details } : {}) };
  try {
    const value = await Promise.race([
      job,
      new Promise<never>((_done, reject) => {
        abort = () => reject(bounded.reason);
        if (bounded.aborted) abort();
        else bounded.addEventListener('abort', abort, { once: true });
      }),
    ]);
    bounded.throwIfAborted();
    return {
      check: { ...check, status: 'passed', ...(reason ? { reason } : {}) },
      value,
    };
  } catch (error) {
    let cleanup = '';
    if (bounded.aborted) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      cleanup = await Promise.race([
        job.then(
          () => '',
          (cause: unknown) =>
            cause === bounded.reason
              ? ''
              : ` Probe completion/cleanup: ${errorText(cause)}`,
        ),
        new Promise<string>((done) => {
          cleanupTimer = setTimeout(
            () =>
              done(
                ' Probe did not settle after cancellation. Cleanup could not be confirmed.',
              ),
            15000,
          );
        }),
      ]);
      clearTimeout(cleanupTimer);
    }
    signal.throwIfAborted();
    return {
      check: {
        ...check,
        status: 'failed',
        reason: reason
          ? `${reason}${cleanup}`
          : `${errorText(error)}${cleanup} Plugin availability is unknown unless established by another check.`,
      },
    };
  } finally {
    clearTimeout(timer);
    if (abort) bounded.removeEventListener('abort', abort);
  }
}
