import { withAgentExecutionTimeout } from '../shared/agent-timeout.js';
import { randomUUID } from 'node:crypto';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  Operation,
} from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';
import { checkPiAgent } from './doctor.js';

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
>['create'] = async (rawConfig, ctx) => {
  ctx.event?.on('rsi/doctor', checkPiAgent);
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
        const session = await createPiSession(
          config,
          async (role, goal, parent, childSignal) => {
            childSignal.throwIfAborted();
            const runId = `child-${randomUUID()}`;
            context.event.emit('rsi/agent-observation', {
              runId: parent.runId,
              event: {
                type: 'subagent.activity',
                activity: 'started',
                childRunId: runId,
                text: goal,
              },
            });
            return runTask(
              {
                ...parent,
                role,
                goal,
                runId,
                parentRunId: parent.runId,
                outputSchema: {
                  type: 'object',
                  properties: { findings: { type: 'string' } },
                  required: ['findings'],
                  additionalProperties: false,
                },
              },
              childSignal,
            );
          },
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
