import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';
import {
  agentBackend,
  nativeCapabilities,
} from '../shared/agent-backend/runner.js';
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
  return agentBackend({
    id: 'agent.claudecode',
    capabilities: nativeCapabilities(true),
    timeoutMs: config.timeoutMs,
    async run(session) {
      return runSession({
        config,
        directory: session.directory,
        request: session.request,
        signal: session.signal,
        launch: session.launch,
        record: session.record,
      });
    },
  });
};
