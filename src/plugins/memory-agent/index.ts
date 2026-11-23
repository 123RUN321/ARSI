import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type AgentEditingConfig } from './schema.js';
import { memoryContract } from '../../contracts/plugin-types/index.js';
import { createMemoryAgent } from './service.js';
import { checkAgentEditor } from '../shared/agent-editing/doctor.js';
export const memoryDefinition: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  AgentEditingConfig
> = {
  id: 'memory.agent',
  description: 'Consolidate experiment experience into reusable memory.',
  contract: memoryContract,
  configSchema,
  create(config, ctx) {
    ctx.event.on('rsi/doctor', checkAgentEditor);
    return createMemoryAgent(config, ctx);
  },
};
