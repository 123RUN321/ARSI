import type { Registry } from '../../runtime/registry/index.js';
import type {
  OperationDefinition,
  OperatorProposerInput,
  OperatorProposerOutput,
} from '../../contracts/index.js';
import { operatorProposerContract } from '../../contracts/plugin-types/proposer-operator.js';
import { configSchema, type OperatorProposerConfig } from './schema.js';
import { createOperatorProposer } from './service.js';
import { checkOperatorProposer } from './doctor.js';
export { createOperatorProposer };
export const operatorProposerDefinition: OperationDefinition<
  OperatorProposerInput,
  OperatorProposerOutput,
  OperatorProposerConfig
> = {
  id: 'proposer.operator',
  contract: operatorProposerContract,
  configSchema,
  create: createOperatorProposer,
};

export function register(registry: Registry): void {
  registry.registerOperation(operatorProposerDefinition, (events) => {
    events.on('rsi/doctor', checkOperatorProposer);
  });
}
