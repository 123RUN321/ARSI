import type { Registry } from '../../runtime/registry/index.js';
import type {
  OperationDefinition,
  ProposerInput,
  ProposerOutput,
} from '../../contracts/index.js';
import { configSchema, type AgentEditingConfig } from './schema.js';
import { proposerContract } from '../../contracts/plugin-types/index.js';
import { createProposerAgent } from './service.js';
import { checkProposerAgent } from './doctor.js';
export const proposerDefinition: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  AgentEditingConfig
> = {
  id: 'proposer.agent',
  description: 'Propose candidate edits using an agent.',
  contract: proposerContract,
  configSchema,
  create: createProposerAgent,
};

export function register(registry: Registry): void {
  registry.registerOperation(proposerDefinition, (events) => {
    events.on('rsi/doctor', checkProposerAgent);
  });
}
