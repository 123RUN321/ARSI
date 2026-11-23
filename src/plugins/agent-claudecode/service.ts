import { withAgentExecutionTimeout } from '../shared/agent-timeout.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  Operation,
} from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';
import { checkClaudeCodeAgent } from './doctor.js';

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
>['create'] = async (rawConfig, ctx) => {
  ctx.event?.on('rsi/doctor', checkClaudeCodeAgent);
  const config = parseConfig<ResolvedAgentClaudeCodeConfig>(
    configSchema,
    rawConfig,
    'agent.claudecode config',
  );
  const operation: Operation<AgentInput, AgentOutput> = {
    async execute(request, context) {
      if (request.role !== undefined)
        throw new Error('For Claude Code role delegation, use native Agent');
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
  return withAgentExecutionTimeout(operation, config.timeoutMs);
};
