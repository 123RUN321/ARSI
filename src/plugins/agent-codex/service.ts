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
  type AgentCodexConfig,
  type ResolvedAgentCodexConfig,
} from './schema.js';
import { runSession } from './session.js';

export const createAgentCodex: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentCodexConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<ResolvedAgentCodexConfig>(
    configSchema,
    rawConfig,
    'agent.codex config',
  );
  return agentBackend({
    id: 'agent.codex',
    capabilities: nativeCapabilities(true),
    timeoutMs: config.timeoutMs,
    async run(session) {
      return runSession({
        executable: config.executable,
        directory: session.directory,
        model: config.model,
        reasoningEffort: config.thinkingLevel,
        request: session.request,
        signal: session.signal,
        launch: session.launch,
        record: session.record,
      });
    },
  });
};
