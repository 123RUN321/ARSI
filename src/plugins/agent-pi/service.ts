import { withAgentExecutionTimeout } from '../shared/agent-timeout.js';
import { randomUUID } from 'node:crypto';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  Operation,
} from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';

import {
  configSchema,
  type AgentPiConfig,
  type ResolvedAgentPiConfig,
} from './schema.js';
import { createPiSession, type PiTask } from './session.js';
export { resolveModelConfig } from './session.js';

/** Pi uses its SDK in process; observations and budget charges are explicit calls. */
export const createAgentPi: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentPiConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<ResolvedAgentPiConfig>(
    configSchema,
    rawConfig,
    'agent.pi config',
  );
  if (config.maxTokens !== undefined && config.maxTokens > config.contextWindow)
    throw new Error('agent.pi maxTokens must not exceed contextWindow');
  const operation: Operation<AgentInput, AgentOutput> = {
    async execute(request, context) {
      async function runTask(
        task: PiTask,
        signal: AbortSignal,
      ): Promise<AgentOutput> {
        if (task.parentRunId !== null)
          context.event.emit('rsi/agent-observation', {
            runId: task.runId,
            event: {
              type: 'message.completed',
              messageId: 'task',
              role: 'user',
              text: task.goal,
            },
          });
        const session = await createPiSession(
          config,
          (role, goal, parent, childSignal) =>
            runTask(
              {
                ...parent,
                role,
                goal,
                runId: `child-${randomUUID()}`,
                parentRunId: parent.runId,
                outputSchema: {
                  type: 'object',
                  properties: { findings: { type: 'string' } },
                  required: ['findings'],
                  additionalProperties: false,
                },
              },
              childSignal,
            ),
        );
        return session.execute(task, context.extend({ signal }));
      }
      return runTask(
        {
          ...request,
          cwd: request.cwd,
          runId: 'main',
          parentRunId: null,
        },
        context.signal,
      );
    },
    async dispose() {},
  };
  return withAgentExecutionTimeout(operation, config.executionTimeoutMs);
};
