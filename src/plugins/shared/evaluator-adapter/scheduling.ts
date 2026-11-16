export type EvaluatorScheduling = {
  concurrency: number;
  preparationConcurrency: number;
  reason: string;
};

/** Explicit process-local operational settings; never rewrite a locked Recipe. */
export function evaluatorScheduling(
  env: Record<string, string | undefined> = process.env,
): EvaluatorScheduling | undefined {
  const execution = env.RSI_EVALUATOR_CONCURRENCY;
  const preparation = env.RSI_EVALUATOR_PREPARATION_CONCURRENCY;
  const reason = env.RSI_EVALUATOR_SCHEDULING_REASON;
  if (
    execution === undefined &&
    preparation === undefined &&
    reason === undefined
  )
    return undefined;
  const positive = (value: string | undefined, name: string): number => {
    if (
      !value ||
      !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new Error(`${name} must be a positive safe integer`);
    return Number(value);
  };
  if (!reason?.trim())
    throw new Error('RSI_EVALUATOR_SCHEDULING_REASON is required');
  return {
    concurrency: positive(execution, 'RSI_EVALUATOR_CONCURRENCY'),
    preparationConcurrency: positive(
      preparation,
      'RSI_EVALUATOR_PREPARATION_CONCURRENCY',
    ),
    reason: reason.trim(),
  };
}
