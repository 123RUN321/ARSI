import type {
  ApplicationInput,
  ApplicationOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type AgentbundleConfig } from './schema.js';
import { applicationContract } from '../../contracts/plugin-types/index.js';
import { createApplicationAgentbundle } from './service.js';
import { checkAgentbundleApplication } from './doctor.js';
export const agentbundleDefinition: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  AgentbundleConfig
> = {
  id: 'application.agentbundle',
  description:
    'Manage file-based agent bundles and isolated execution instances.',
  contract: applicationContract,
  configSchema,
  async create(config, ctx) {
    ctx.event.on('rsi/doctor', (context) =>
      checkAgentbundleApplication(context, operation),
    );
    const operation = await createApplicationAgentbundle(config, ctx);
    return operation;
  },
};
