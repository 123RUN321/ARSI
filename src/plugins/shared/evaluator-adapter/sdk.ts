import type { EvaluatorRunOptions } from 'ember-evaluator';
import type { EvaluatorScheduling } from './scheduling.js';
export type SdkRunOptions = EvaluatorRunOptions & {
  scheduling?: EvaluatorScheduling;
};
export type EvaluatorRunner = (options: SdkRunOptions) => Promise<unknown>;
export async function sdkRunner(options: SdkRunOptions): Promise<unknown> {
  const sdk = await import('ember-evaluator');
  if (
    options.scheduling &&
    (sdk as unknown as { SCHEDULING_OVERRIDES_API_VERSION?: number })
      .SCHEDULING_OVERRIDES_API_VERSION !== 1
  )
    throw new Error(
      'Evaluator SDK does not support audited scheduling overrides',
    );
  return new sdk.Evaluator().run(options);
}
