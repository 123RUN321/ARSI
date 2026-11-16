import { parseAgentResult } from '../shared/agent-backend/output.js';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { parseConfig } from '../../shared/schema.js';
import {
  agentBackend,
  nativeCapabilities,
} from '../shared/agent-backend/runner.js';
import { configSchema, type AgentDshConfig } from './schema.js';
import { runDshProcess } from './process.js';
import { dshObservations } from './observations.js';

export const createAgentDsh: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentDshConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<AgentDshConfig & { executable: string }>(
    configSchema,
    rawConfig,
    'agent.dsh config',
  );
  return agentBackend({
    id: 'agent.dsh',
    capabilities: nativeCapabilities(true),
    timeoutMs: config.timeoutMs,
    async run(session) {
      const launch = session.launch;
      const patch = join(session.directory, 'scratch', 'dsh-launch.json');
      await writeFile(
        patch,
        JSON.stringify([
          ...['credentials', 'authorization', 'deepseek-account'].map((id) => ({
            id,
            disabled: false,
          })),
          {
            id: 'agent-instructions',
            config: { maxBytes: 65536, projectRootMarkers: ['.rsi-project'] },
          },
          {
            id: 'skill-filesystem',
            config: {
              customSkillDirs: [join(session.directory, '.agents', 'skills')],
            },
          },
        ]),
        { mode: 0o600 },
      );
      const observe = dshObservations(session.record);
      let sessionId: string | undefined;
      let finalText: string | undefined;
      try {
        await runDshProcess(
          config.executable,
          patch,
          JSON.stringify({
            goal: session.request.goal,
            instruction:
              'Read AGENTS.md. Edit candidate/ directly only when authorized. Return only the JSON object matching outputSchema.',
            outputSchema: session.request.outputSchema,
          }),
          (line) => {
            const event = object(JSON.parse(line));
            observe(event);
            if (event.type === 'session') {
              if (sessionId !== undefined)
                throw new Error('DSH emitted duplicate session events');
              sessionId = string(event.sessionId);
            } else if (event.type === 'error')
              throw new Error(`DSH execution failed: ${String(event.message)}`);
            else if (event.type === 'final') {
              if (
                !sessionId ||
                event.sessionId !== sessionId ||
                finalText !== undefined
              )
                throw new Error('Invalid DSH final session');
              if (object(event.reason).kind !== 'completed')
                throw new Error('DSH task did not complete');
              finalText = string(event.text);
            }
          },
          launch,
        );
        if (finalText === undefined)
          throw new Error('DSH returned no final result');
        return parseAgentResult(finalText);
      } finally {
        await rm(patch, { force: true });
      }
    },
  });
};
