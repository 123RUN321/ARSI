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
  type AgentOpenCodeConfig,
  type ResolvedAgentOpenCodeConfig,
} from './schema.js';
import { runSession } from './session.js';

export const createAgentOpenCode: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentOpenCodeConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<ResolvedAgentOpenCodeConfig>(
    configSchema,
    rawConfig,
    'agent.opencode config',
  );
  return agentBackend({
    id: 'agent.opencode',
    capabilities: nativeCapabilities(false),
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
