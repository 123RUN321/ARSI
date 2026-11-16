import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';

import {
  configSchema,
  type AgentClaudeCodeConfig,
  type ResolvedAgentClaudeCodeConfig,
} from './schema.js';
import { runSession } from './session.js';

export const createAgentClaudeCode: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentClaudeCodeConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<ResolvedAgentClaudeCodeConfig>(
    configSchema,
    rawConfig,
    'agent.claudecode config',
  );
  return {
    async execute(request, context) {
      return runSession({
        config,
        directory: context.directory,
        request,
        signal: context.signal,
        launch: (spec, onLine) => context.runAgentProcess(spec, onLine),
        record: (observation) =>
          context.event.emit('rsi/agent-observation', observation),
      });
    },
    async dispose() {},
  };
};
