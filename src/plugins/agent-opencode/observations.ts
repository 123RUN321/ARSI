import type { AgentObservation, JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';

export function openCodeObservations(
  record: (event: AgentObservation) => void,
): (event: JsonObject, completedText: string | null) => void {
  let sessionId: string | undefined;
  const children = new Set<string>();
  return (event, completedText) => {
    if (!sessionId && typeof event.sessionID === 'string') {
      sessionId = event.sessionID;
      record({
        runId: 'main',
        native: { sessionId },
        event: { type: 'session.started', sessionId },
      });
    }
    if (
      !event.part ||
      typeof event.part !== 'object' ||
      Array.isArray(event.part)
    )
      return;
    const part = object(event.part);
    const runId =
      typeof event.sessionID === 'string' && event.sessionID !== sessionId
        ? event.sessionID
        : 'main';
    if (runId !== 'main' && !children.has(runId)) {
      children.add(runId);
      record({
        runId,
        event: {
          type: 'run.started',
          backend: 'agent.opencode',
          parentRunId: null,
        },
      });
    }
    const emit = (value: AgentObservation['event']): void =>
      record({
        runId,
        ...(typeof event.sessionID === 'string'
          ? { native: { sessionId: event.sessionID } }
          : {}),
        event: value,
      });
    if (
      event.type === 'text' &&
      typeof part.messageID === 'string' &&
      typeof part.text === 'string'
    ) {
      emit({
        type: 'message.appended',
        messageId: part.messageID,
        text: part.text,
      });
    } else if (
      (event.type === 'text' || event.type === 'reasoning') &&
      typeof part.text === 'string' &&
      typeof part.id === 'string'
    )
      emit({
        type: 'message.completed',
        messageId: part.id,
        role: 'assistant',
        text: event.type === 'text' ? part.text : '',
        ...(event.type === 'reasoning' ? { thinking: part.text } : {}),
      });
    else if (
      event.type === 'tool_use' &&
      typeof part.id === 'string' &&
      typeof part.tool === 'string'
    ) {
      const state = object(part.state);
      emit({
        type: 'tool.started',
        toolCallId: part.id,
        name: part.tool,
        input: state.input ?? null,
      });
      if (state.status === 'completed' || state.status === 'error') {
        const time = object(state.time ?? {});
        emit({
          type: 'tool.completed',
          toolCallId: part.id,
          output: state.output ?? state.error ?? null,
          status: state.status === 'error' ? 'failed' : 'succeeded',
          ...(typeof time.start === 'number' && typeof time.end === 'number'
            ? { durationMs: time.end - time.start }
            : {}),
        });
      }
    } else if (event.type === 'step_finish') {
      if (typeof part.messageID === 'string' && completedText)
        emit({
          type: 'message.completed',
          messageId: part.messageID,
          role: 'assistant',
          text: completedText,
          ...(part.reason === 'stop'
            ? { phase: 'final_answer' }
            : part.reason === 'tool-calls'
              ? { phase: 'commentary' }
              : {}),
        });
      if (part.tokens !== undefined)
        emit({
          type: 'usage.reported',
          usageId: String(part.id),
          scope: 'step',
          mode: 'incremental',
          values: { tokens: part.tokens, cost: part.cost ?? null },
        });
      if (part.reason === 'stop')
        emit({
          type: 'run.finished',
          status: 'completed',
          nativeStatus: part.reason,
        });
    }
  };
}
