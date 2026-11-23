import type { Registry } from '../../runtime/registry/index.js';
import type {
  MetricSelectorInput,
  MetricSelectorOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type MetricSelectorConfig } from './schema.js';
import { metricSelectorContract } from '../../contracts/plugin-types/index.js';
import { createMetricSelector } from './service.js';
import { checkOperationConfiguration } from '../shared/doctor/checks.js';
export const metricSelectorDefinition: OperationDefinition<
  MetricSelectorInput,
  MetricSelectorOutput,
  MetricSelectorConfig
> = {
  id: 'selector.metric',
  description: 'Select candidates using recorded metrics.',
  contract: metricSelectorContract,
  configSchema,
  create: createMetricSelector,
};

export function register(registry: Registry): void {
  registry.registerOperation(metricSelectorDefinition, (events) => {
    events.on('rsi/doctor', checkOperationConfiguration);
  });
}
