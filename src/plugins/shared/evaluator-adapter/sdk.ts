import type { EvaluatorRunOptions } from 'arsi-evaluator';
import {
  recordImageCleanupInput,
  type ImageCleanupSource,
} from './image-cleanup.js';
export type SdkRunOptions = EvaluatorRunOptions;
export type EvaluatorRunner = (
  options: SdkRunOptions,
  source?: ImageCleanupSource,
) => Promise<unknown>;
export async function sdkRunner(
  options: SdkRunOptions,
  source?: ImageCleanupSource,
): Promise<unknown> {
  const sdk = await import('arsi-evaluator');
  if (source)
    await recordImageCleanupInput(
      source,
      options.configPath,
      options.env ?? process.env,
    );
  return new sdk.Evaluator().run(options);
}
