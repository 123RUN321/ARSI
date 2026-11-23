import type { AgentEditingConfig } from './schema.js';
import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { string } from '../../shared/json.js';
import { editResource } from '../shared/agent-editing/index.js';
import { buildComparisonContext } from './comparison.js';
import { errorText } from '../../shared/errors.js';
import { checkAgentEditor } from '../shared/agent-editing/doctor.js';

export const createMemoryAgent: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  AgentEditingConfig
>['create'] = async (config, ctx) => {
  ctx.event?.on('rsi/doctor', (request) => checkAgentEditor(request));
  return {
    async execute(input, context) {
      try {
        const comparison =
          input.comparison === undefined
            ? undefined
            : await buildComparisonContext(input, context);
        const updated = await editResource(
          config,
          input,
          input.memoryRef,
          context,
          comparison,
        );
        if (updated.changeRef !== null)
          return {
            status: 'updated',
            memoryRef: string(updated.resourceRef),
            changeRef: updated.changeRef,
            reason: updated.reason,
          };
        return {
          status: 'no-change',
          memoryRef: updated.resourceRef,
          changeRef: null,
          reason: updated.reason,
        };
      } catch (error) {
        if (
          context.signal.aborted ||
          (error instanceof Error && error.name === 'ExperimentBudgetExceeded')
        )
          throw error;
        return {
          status: 'failed',
          memoryRef: input.memoryRef,
          changeRef: null,
          reason: errorText(error),
        };
      }
    },
    async dispose() {},
  };
};
