import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';

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
  return {
    async execute(request, context) {
      return runSession({
        config,
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
