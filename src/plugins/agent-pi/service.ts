import { randomUUID } from 'node:crypto';
import type {
  AgentInput,
  AgentOutput,
  AgentRecorder,
  OperationDefinition,
} from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';
import {
  agentBackend,
  nativeCapabilities,
} from '../shared/agent-backend/runner.js';
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
  const capabilities = nativeCapabilities(true);
  capabilities.hardModelCallLimit = true;
  return agentBackend({
    id: 'agent.pi',
    capabilities,
    timeoutMs: config.executionTimeoutMs,
    async run(execution, context) {
      const recorder: AgentRecorder = { record: execution.record, close() {} };
      const scope = context.extend({
        signal: execution.signal,
        agentRecorder: recorder,
      });
      async function runTask(task: PiTask): Promise<AgentOutput> {
        if (task.parentRunId !== null)
          execution.record({
            runId: task.runId,
            event: {
              type: 'message.completed',
              messageId: 'task',
              role: 'user',
              text: task.goal,
            },
          });
        const session = await createPiSession(config, (role, goal, parent) =>
          runTask({
            ...parent,
            role,
            goal,
            mode: 'analyze',
            runId: `child-${randomUUID()}`,
            parentRunId: parent.runId,
            outputSchema: {
              type: 'object',
              properties: { findings: { type: 'string' } },
              required: ['findings'],
              additionalProperties: false,
            },
          }),
        );
        return session.execute(task, scope);
      }
      return runTask({
        ...execution.request,
        cwd: execution.directory,
        runId: 'main',
        parentRunId: null,
      });
    },
  });
};
