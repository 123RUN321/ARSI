import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';

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
  return {
    async execute(request, context) {
      return runSession({
        executable: config.executable,
        model: config.model,
        reasoningEffort: config.thinkingLevel,
        directory: request.cwd,
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
