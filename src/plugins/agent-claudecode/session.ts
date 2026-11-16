import { claudeObservations } from './observations.js';
import type {
  AgentObservation,
  AgentProcessLauncher,
} from '../../contracts/index.js';
import type { AgentInput, JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import type { ResolvedAgentClaudeCodeConfig } from './schema.js';
import { runNativeJsonProcess as runClaudeProcess } from '../shared/native-agent/json-process.js';

/** Native CLI owns model access, tools, structured-output generation and retries. */
export async function runSession(options: {
  config: ResolvedAgentClaudeCodeConfig;
  directory: string;
  request: AgentInput;
  signal: AbortSignal;
  record: (event: AgentObservation) => void;
  launch: AgentProcessLauncher;
}): Promise<JsonObject> {
  const { config, request, record } = options;
  const observe = claudeObservations(record);
  let result: JsonObject | undefined;
  let completed = false;
  // Keep native model/auth settings; constrain task tools independently.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--forward-subagent-text',
    '--json-schema',
    JSON.stringify(request.outputSchema),
  ];
  if (config.model !== undefined) args.push('--model', config.model);
  if (config.effort !== undefined) args.push('--effort', config.effort);
  await runClaudeProcess(
    config.executable,
    args,
    JSON.stringify({
      goal: request.goal,
      instruction:
        'Read CLAUDE.md and the project instructions. Use native Skills and Agent delegation when appropriate. Edit candidate/ directly only when authorized. Return only the requested structured result.',
    }),
    (line) => {
      const event = object(JSON.parse(line));
      observe(event);
      if (event.type === 'result' && event.parent_tool_use_id == null) {
        if (completed)
          throw new Error('Claude Code returned multiple terminal results');
        completed = true;
        if (
          Array.isArray(event.permission_denials) &&
          event.permission_denials.length
        )
          throw new Error(
            'Claude Code requires permission for a denied tool; this non-interactive Agent call cannot approve it',
          );
        if (event.is_error !== false || event.subtype !== 'success')
          throw new Error(
            `Claude Code task failed (${typeof event.subtype === 'string' ? event.subtype : 'unknown status'})`,
          );
        if (event.structured_output === undefined)
          throw new Error('Claude Code returned no structured output');
        result = object(event.structured_output);
      }
    },
    options.launch,
  );
  if (!result) throw new Error('Claude Code returned no validated output');
  return result;
}
