import { cleanupEvaluatorBinding } from '../shared/evaluator-adapter/cleanup.js';
import type { OperationDefinition } from '../../contracts/index.js';
import {
  operatorbenchContract,
  type OperatorbenchInput,
  type OperatorbenchOutput,
} from '../../contracts/plugin-types/operatorbench.js';
import {
  operatorbenchConfigSchema,
  type OperatorbenchConfig,
} from './schema.js';
import { createOperatorbench } from './service.js';
import { operatorbenchDoctor } from './doctor.js';

export { createOperatorbench };

export const operatorbenchDefinition: OperationDefinition<
  OperatorbenchInput,
  OperatorbenchOutput,
  OperatorbenchConfig
> = {
  id: 'evaluator.operatorbench',
  contract: operatorbenchContract,
  configSchema: operatorbenchConfigSchema,
  create(config, ctx) {
    ctx.event.on('rsi/doctor', operatorbenchDoctor);
    ctx.event.on('rsi/cleanup', (context) =>
      cleanupEvaluatorBinding(context, 'kernel'),
    );
    return createOperatorbench(config, ctx);
  },
};
