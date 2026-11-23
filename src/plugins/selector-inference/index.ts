import type { Registry } from '../../runtime/registry/index.js';
import type {
  MetricSelectorInput,
  MetricSelectorOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { metricSelectorContract } from '../../contracts/plugin-types/index.js';
import { checkOperationConfiguration } from '../shared/doctor/checks.js';
import { configSchema, type MetricSelectorConfig } from './schema.js';
import { createInferenceSelector } from './service.js';

export const inferenceSelectorDefinition: OperationDefinition<
  MetricSelectorInput,
  MetricSelectorOutput,
  MetricSelectorConfig
> = {
  id: 'selector.inference',
  description:
    'Improve inference constraint feasibility before optimizing performance.',
  contract: metricSelectorContract,
  configSchema,
  create: createInferenceSelector,
};

export function register(registry: Registry): void {
  registry.registerOperation(inferenceSelectorDefinition, (events) => {
    events.on('rsi/doctor', checkOperationConfiguration);
  });
}
