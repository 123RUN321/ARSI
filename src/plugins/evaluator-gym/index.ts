import type {
  GymInput,
  GymOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { gymContract } from '../../contracts/plugin-types/index.js';
import { gymPluginConfigSchema, type GymPluginConfig } from './schema.js';
import { createGymOperation } from './service.js';

export const gymDefinition: OperationDefinition<
  GymInput,
  GymOutput,
  GymPluginConfig
> = {
  id: 'evaluator.gym',
  description:
    'Run mode-restricted Gym training evaluations or holdout promotions.',
  contract: gymContract,
  configSchema: gymPluginConfigSchema,
  create: (config, context) => createGymOperation(config, context),
};
