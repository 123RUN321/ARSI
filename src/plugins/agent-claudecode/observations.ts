import type { AgentObservation, JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';

export function claudeObservations(
  record: (event: AgentObservation) => void,
): (event: JsonObject) => void {
  const children = new Set<string>();
  const tools = new Map<string, { runId: string; prompt?: string }>();
  const lastMessages = new Map<
    string,
    Extract<AgentObservation['event'], { type: 'message.completed' }>
  >();
  let serial = 0;
  return (event) => {
    const runId =
      typeof event.parent_tool_use_id === 'string'
        ? event.parent_tool_use_id
        : 'main';
    if (runId !== 'main' && !children.has(runId)) {
      children.add(runId);
      const tool = tools.get(runId);
      const parentRunId = tool?.runId ?? null;
      if (parentRunId !== null)
        record({
          runId: parentRunId,
          event: {
            type: 'subagent.activity',
            activity: 'started',
            childRunId: runId,
            ...(tool?.prompt ? { text: tool.prompt } : {}),
          },
        });
      record({
        runId,
        event: {
          type: 'run.started',
          backend: 'agent.claudecode',
          parentRunId,
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
          const input = block.input;
          tools.set(block.id, {
            runId,
            ...((block.name === 'Agent' || block.name === 'Task') &&
            input &&
            typeof input === 'object' &&
            !Array.isArray(input) &&
            typeof input.prompt === 'string'
              ? { prompt: input.prompt }
              : {}),
          });
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
      if (text || thinking) {
        const phase =
          event.type === 'assistant' &&
          blocks.some((block) => block.type === 'tool_use')
            ? 'commentary'
            : runId !== 'main' &&
                event.type === 'assistant' &&
                message.stop_reason === 'end_turn' &&
                text
              ? 'final_answer'
              : undefined;
        const completed = {
          type: 'message.completed',
          messageId: `${typeof message.id === 'string' ? message.id : event.type}:${serial++}`,
          role: String(event.type),
          text,
          thinking,
          ...(phase ? { phase } : {}),
        } as const;
        if (event.type === 'assistant' && text)
          lastMessages.set(runId, completed);
        emit(completed);
      }
    } else if (event.type === 'result') {
      const last = lastMessages.get(runId);
      if (
        event.is_error === false &&
        event.subtype === 'success' &&
        typeof event.result === 'string' &&
        event.result.trim()
      )
        emit({
          type: 'message.completed',
          messageId:
            last?.text === event.result ? last.messageId : `result:${serial++}`,
          role: 'assistant',
          text: event.result,
          ...(last?.text === event.result && last.thinking
            ? { thinking: last.thinking }
            : {}),
          phase: 'final_answer',
        });
      lastMessages.delete(runId);
      if (event.usage !== undefined)
        emit({
          type: 'usage.reported',
          usageId: 'result',
          scope: 'session',
          mode: 'cumulative',
          values: { usage: event.usage, models: event.modelUsage ?? null },
        });
      emit({
        type: 'run.finished',
        ...(typeof event.subtype === 'string'
          ? { nativeStatus: event.subtype }
          : {}),
        status:
          event.is_error === false && event.subtype === 'success'
            ? 'completed'
            : 'failed',
      });
    }
  };
}
