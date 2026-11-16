import { observeNative } from '../shared/native-agent/observe.js';
import { parseAgentResult } from '../shared/native-agent/result.js';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { parseConfig } from '../../shared/schema.js';

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
  return {
    async execute(request, context) {
      const launch: import('../../contracts/index.js').AgentProcessLauncher = (
        spec,
        onLine,
      ) => context.runAgentProcess(spec, onLine);
      const patch = join(context.directory, 'dsh-launch.json');
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
              customSkillDirs: [join(request.cwd, '.agents', 'skills')],
            },
          },
        ]),
        { mode: 0o600 },
      );
      const record = (
        observation: import('../../contracts/index.js').AgentObservation,
      ): void => {
        context.event.emit('rsi/agent-observation', observation);
      };
      const observe = observeNative(
        dshObservations(record),
        record,
        context.signal,
      );
      let sessionId: string | undefined;
      let finalText: string | undefined;
      try {
        await runDshProcess(
          config.executable,
          patch,
          JSON.stringify({
            goal: request.goal,
            instruction:
              'Read AGENTS.md. Return proposed changes through the requested result Schema; leave task input files unchanged. Return only the JSON object matching outputSchema.',
            outputSchema: request.outputSchema,
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
    async dispose() {},
  };
};
