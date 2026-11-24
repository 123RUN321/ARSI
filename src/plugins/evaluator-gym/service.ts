import type {
  GymInput,
  GymOutput,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import { validate } from '../../shared/schema.js';
import { gymConfigSchema } from './evaluate/schema.js';
import { createGym as createGymEvaluate } from './evaluate/service.js';
import { promotionConfigSchema } from './promotion/schema.js';
import { createGymPromotion } from './promotion/service.js';
import { gymPluginConfigSchema, type GymPluginConfig } from './schema.js';
import { gymDoctor } from './evaluate/doctor.js';
import { gymPromotionDoctor } from './promotion/doctor.js';

export async function createGymOperation(
  config: GymPluginConfig,
  context: RuntimeContext,
): Promise<Operation<GymInput, GymOutput>> {
  validate(gymPluginConfigSchema, config, 'gym plugin config');
  if (config.mode === 'evaluate') {
    context.event?.on('rsi/doctor', (request) =>
      gymDoctor({ ...request, binding: { ...request.binding, config } }),
    );
    const { mode: _mode, ...evaluateConfig } = config;
    const operation = await createGymEvaluate(
      evaluateConfig,
      context,
      gymConfigSchema,
    );
    return {
      async execute(input, executionContext): Promise<GymOutput> {
        if (input.action !== 'evaluate') {
          throw new Error(
            `gym binding is evaluate-only; rejected action ${input.action}`,
          );
        }
        const output = await operation.execute(input, executionContext);
        return { action: 'evaluate', measurementRef: output.measurementRef };
      },
      async dispose(): Promise<void> {
        await operation.dispose();
      },
    };
  }

  context.event?.on('rsi/doctor', (request) =>
    gymPromotionDoctor({ ...request, binding: { ...request.binding, config } }),
  );
  const { mode: _mode, ...promotionConfig } = config;
  const operation = await createGymPromotion(
    promotionConfig,
    context,
    promotionConfigSchema,
  );
  return {
    async execute(input, executionContext): Promise<GymOutput> {
      if (input.action !== 'promote') {
        throw new Error(
          `gym binding is promote-only; rejected action ${input.action}`,
        );
      }
      const output = await operation.execute(input, executionContext);
      return { action: 'promote', ...output };
    },
    async dispose(): Promise<void> {
      await operation.dispose();
    },
  };
}
