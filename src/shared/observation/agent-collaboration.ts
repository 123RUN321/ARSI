import type { JsonValue } from '../../contracts/json.js';

export function readAgentCollaboration(value: JsonValue | undefined): {
  tool: 'spawnAgent' | 'wait';
  targets: string[];
  message: string | null;
  states: { runId: string; status: string }[];
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type !== 'collabAgentToolCall' && value.type !== 'collabToolCall')
    return null;
  if (value.tool !== 'spawnAgent' && value.tool !== 'wait') return null;
  const states = value.agentsStates;
  return {
    tool: value.tool,
    targets: Array.isArray(value.receiverThreadIds)
      ? value.receiverThreadIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : [],
    message:
      value.tool === 'spawnAgent' &&
      typeof value.prompt === 'string' &&
      value.prompt.trim()
        ? value.prompt
        : null,
    states:
      states && typeof states === 'object' && !Array.isArray(states)
        ? Object.entries(states).flatMap(([runId, state]) =>
            state &&
            typeof state === 'object' &&
            !Array.isArray(state) &&
            typeof state.status === 'string'
              ? [{ runId, status: state.status }]
              : [],
          )
        : [],
  };
}
