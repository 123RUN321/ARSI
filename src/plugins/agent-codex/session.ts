import { parseAgentResult } from '../shared/agent-backend/output.js';
import { codexObservations } from './observations.js';
import type {
  AgentObservation,
  AgentProcessLauncher,
} from '../../contracts/index.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  projectMarker,
  roleNamePattern,
} from '../shared/agent-editing/project.js';
import type { AgentInput, JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { runCodexProcess } from './process.js';

function nativeError(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const error = object(value);
  const message = typeof error.message === 'string' ? error.message : '';
  const code =
    typeof error.code === 'string' || typeof error.code === 'number'
      ? ` [${error.code}]`
      : '';
  return message || code ? `: ${message}${code}` : '';
}

/** Codex owns native tools, configuration and recovery. */
export async function runSession(options: {
  executable: string;
  directory: string;
  model?: string;
  reasoningEffort?: string;
  request: AgentInput;
  signal: AbortSignal;
  record: (event: AgentObservation) => void;
  launch: AgentProcessLauncher;
}): Promise<JsonObject> {
  const { request, record } = options;
  const observe = codexObservations(record);
  let threadId = '';
  let response = '';
  let result: JsonObject | undefined;
  const prompt = JSON.stringify({
    goal: request.goal,
    instruction:
      'Use the project instructions and return the requested JSON result.',
  });
  const launchConfig = [
    `project_root_markers=[${JSON.stringify(projectMarker)}]`,
  ];
  const agentsDir = join(options.directory, '.codex', 'agents');
  const roles = await readdir(agentsDir, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      return [];
    },
  );
  let hasRoles = false;
  for (const role of roles) {
    const name = role.name.slice(0, -5);
    if (
      role.isFile() &&
      role.name.endsWith('.toml') &&
      new RegExp(roleNamePattern).test(name)
    ) {
      hasRoles = true;
      launchConfig.push(
        `agents.${name}.config_file=${JSON.stringify(join(agentsDir, role.name))}`,
      );
    }
  }
  if (hasRoles)
    launchConfig.push('agents.max_depth=1', 'features.multi_agent=true');
  await runCodexProcess(
    options.executable,
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'ember_rsi', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      },
    }) + '\n',
    (line, send) => {
      const message = object(JSON.parse(line));
      observe(message, threadId);
      if (message.error)
        throw new Error(
          `Codex app-server request failed${nativeError(message.error)}`,
        );
      if (message.method === undefined && message.id === 1) {
        send({ method: 'initialized' });
        send({
          id: 2,
          method: 'thread/start',
          params: {
            cwd: options.directory,
            ephemeral: !hasRoles,
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.reasoningEffort === undefined
              ? {}
              : {
                  config: { model_reasoning_effort: options.reasoningEffort },
                }),
          },
        });
      } else if (message.method === undefined && message.id === 2) {
        const configuration = object(message.result);
        threadId = string(object(configuration.thread).id);
        record({
          runId: 'main',
          native: { sessionId: threadId },
          event: {
            type: 'session.started',
            sessionId: threadId,
            ...(typeof configuration.model === 'string'
              ? { model: configuration.model }
              : {}),
          },
        });
        send({
          id: 3,
          method: 'turn/start',
          params: {
            threadId,
            input: [{ type: 'text', text: prompt }],
            outputSchema: request.outputSchema,
            cwd: options.directory,
          },
        });
      } else if (message.method === 'item/completed') {
        const params = object(message.params);
        if (typeof params.threadId === 'string' && params.threadId !== threadId)
          return;
        const item = object(params.item);
        if (item.type === 'agentMessage' && item.phase !== 'commentary') {
          if (typeof item.text !== 'string')
            throw new Error('Invalid Codex agent message');
          response = item.text;
        }
      } else if (message.method === 'turn/completed') {
        const params = object(message.params);
        if (typeof params.threadId === 'string' && params.threadId !== threadId)
          return;
        const turn = object(params.turn);
        if (turn.status !== 'completed')
          throw new Error(
            `Codex turn ${string(turn.status)}${nativeError(turn.error)}`,
          );
        result = parseAgentResult(response);
        return true;
      } else if (message.method && message.id !== undefined) {
        throw new Error(
          `Codex requires interactive input or approval (${string(message.method)}); this non-interactive Agent call cannot answer it`,
        );
      }
    },
    options.launch,
    launchConfig,
  );
  if (!result) throw new Error('Codex returned no validated output');
  return result;
}
