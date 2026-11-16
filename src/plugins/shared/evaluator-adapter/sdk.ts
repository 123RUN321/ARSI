import type { EvaluatorRunOptions } from 'arsi-evaluator';
export type SdkRunOptions = EvaluatorRunOptions;
export type EvaluatorRunner = (options: SdkRunOptions) => Promise<unknown>;
export async function sdkRunner(options: SdkRunOptions): Promise<unknown> {
  const sdk = await import('arsi-evaluator');
  return new sdk.Evaluator().run(options);
}
