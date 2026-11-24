import { observeNative } from '../shared/native-agent/observe.js';
import { parseAgentResult } from '../shared/native-agent/result.js';
import { openCodeObservations } from './observations.js';
import type {
  AgentObservation,
  AgentProcessLauncher,
} from '../../contracts/index.js';
import type { AgentInput, JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { runNativeJsonProcess } from '../shared/native-agent/json-process.js';
import { defaultExecutable, type AgentOpenCodeConfig } from './schema.js';

/** Retain native provider settings and normal host environment. */
export function launchEnvironment(directory: string): NodeJS.ProcessEnv {
  return { ...process.env, PWD: directory };
}

export async function runSession(options: {
  config: AgentOpenCodeConfig;
  directory: string;
  request: AgentInput;
  signal: AbortSignal;
  record: (event: AgentObservation) => void;
  launch: AgentProcessLauncher;
}): Promise<JsonObject> {
  const { config, request, record } = options;
  const observe = observeNative(
    openCodeObservations(record),
    record,
    options.signal,
  );
  const args = ['run', '--standalone', '--format', 'json', '--archived'];
  if (config.model !== undefined) args.push('--model', config.model);
  const messages = new Map<string, string>();
  let sessionId: string | undefined;
  let finalMessage: string | undefined;
  let finalReason: string | undefined;
  await runNativeJsonProcess(
    config.executable ?? defaultExecutable,
    args,
    JSON.stringify({
      goal: request.goal,
      instruction:
        'Read AGENTS.md and the project instructions. Return proposed changes through the requested result Schema; leave task input files unchanged. Your final answer must be only a JSON object matching outputSchema, without Markdown or prose.',
      outputSchema: request.outputSchema,
    }),
    (line) => {
      let event: JsonObject;
      try {
        event = object(JSON.parse(line));
      } catch {
        throw new Error('OpenCode emitted invalid JSON protocol output.');
      }
      observe(event);
      const part = event.part === undefined ? {} : object(event.part);
      if (typeof event.sessionID === 'string') {
        if (sessionId === undefined) sessionId = event.sessionID;
        else if (sessionId !== event.sessionID) return;
      }
      if (
        event.type === 'text' &&
        typeof part.messageID === 'string' &&
        typeof part.text === 'string'
      ) {
        messages.set(
          part.messageID,
          (messages.get(part.messageID) ?? '') + part.text,
        );
      } else if (event.type === 'step_finish') {
        finalMessage =
          typeof part.messageID === 'string' ? part.messageID : undefined;
        finalReason = typeof part.reason === 'string' ? part.reason : undefined;
      } else if (event.type === 'error')
        throw new Error('OpenCode execution failed');
    },
    options.launch,
    launchEnvironment(options.directory),
  );
  if (finalMessage === undefined || finalReason !== 'stop')
    throw new Error(
      'OpenCode returned no successfully completed final answer.',
    );
  return parseAgentResult(messages.get(finalMessage) ?? '');
}
