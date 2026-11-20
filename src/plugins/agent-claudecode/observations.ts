import type { AgentObservation, JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';

export function claudeObservations(
  record: (event: AgentObservation) => void,
): (event: JsonObject) => void {
  const children = new Set<string>();
  const toolOwners = new Map<string, string>();
  let serial = 0;
  return (event) => {
    const runId =
      typeof event.parent_tool_use_id === 'string'
        ? event.parent_tool_use_id
        : 'main';
    if (runId !== 'main' && !children.has(runId)) {
      children.add(runId);
      record({
        runId,
        event: {
          type: 'run.started',
          backend: 'agent.claudecode',
          parentRunId: toolOwners.get(runId) ?? null,
        },
      });
    }
    const emit = (value: AgentObservation['event']): void =>
      record({
        runId,
        ...(typeof event.session_id === 'string'
          ? { native: { sessionId: event.session_id } }
          : {}),
        event: value,
      });
    if (
      event.type === 'system' &&
      event.subtype === 'init' &&
      typeof event.session_id === 'string'
    )
      emit({
        type: 'session.started',
        sessionId: event.session_id,
        ...(typeof event.model === 'string' ? { model: event.model } : {}),
        ...(typeof event.claude_code_version === 'string'
          ? { version: event.claude_code_version }
          : {}),
      });
    if (event.type === 'assistant' || event.type === 'user') {
      const message = object(event.message);
      const blocks = Array.isArray(message.content)
        ? message.content.map((item) => object(item))
        : [];
      let text = '',
        thinking = '';
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string')
          text += block.text;
        else if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string'
        )
          thinking += block.thinking;
        else if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          toolOwners.set(block.id, runId);
          emit({
            type: 'tool.started',
            toolCallId: block.id,
            name: block.name,
            input: block.input ?? null,
          });
        } else if (
          block.type === 'tool_result' &&
          typeof block.tool_use_id === 'string'
        )
          emit({
            type: 'tool.completed',
            toolCallId: block.tool_use_id,
            output: block.content ?? null,
            status: block.is_error ? 'failed' : 'succeeded',
          });
      }
      if (text || thinking)
        emit({
          type: 'message.completed',
          messageId: `${typeof message.id === 'string' ? message.id : event.type}:${serial++}`,
          role: String(event.type),
          text,
          thinking,
        });
    } else if (event.type === 'result') {
      if (runId !== 'main') {
        emit({
          type: 'run.finished',
          status:
            event.is_error === false && event.subtype === 'success'
              ? 'completed'
              : 'failed',
        });
      }
      if (event.usage === undefined) return;
      emit({
        type: 'usage.reported',
        usageId: 'result',
        scope: 'session',
        mode: 'cumulative',
        values: { usage: event.usage, models: event.modelUsage ?? null },
      });
    }
  };
}
