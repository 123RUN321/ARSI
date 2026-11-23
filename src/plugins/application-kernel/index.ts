import type {
  ApplicationInput,
  ApplicationOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { applicationContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type KernelApplicationConfig } from './schema.js';
import { createApplicationKernel } from './service.js';
import { checkKernelApplication } from './doctor.js';

export { createApplicationKernel } from './service.js';
export type { KernelApplicationConfig } from './schema.js';

export const kernelApplicationDefinition: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  KernelApplicationConfig
> = {
  id: 'application.kernel',
  contract: applicationContract,
  configSchema,
  async create(config, ctx) {
    ctx.event.on('rsi/doctor', (context) =>
      checkKernelApplication(context, operation),
    );
    const operation = await createApplicationKernel(config, ctx);
    return operation;
  },
};
