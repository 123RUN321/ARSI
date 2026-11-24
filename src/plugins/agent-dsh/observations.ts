import type { AgentObservation, JsonObject } from '../../contracts/index.js';

export function dshObservations(
  record: (event: AgentObservation) => void,
): (event: JsonObject) => void {
  let sessionId: string | undefined;
  let serial = 0;
  let lastText: string | undefined;
  let lastMessageId: string | undefined;
  return (event) => {
    const emit = (value: AgentObservation['event']): void =>
      record({
        runId: 'main',
        ...(sessionId ? { native: { sessionId } } : {}),
        event: value,
      });
    if (event.type === 'session' && typeof event.sessionId === 'string') {
      sessionId = event.sessionId;
      emit({ type: 'session.started', sessionId });
    }
    if (event.truncated === true)
      emit({
        type: 'observation.gap',
        reason: 'DSH truncated the native event payload',
      });
    if (
      (event.type === 'text' || event.type === 'thinking') &&
      typeof event.text === 'string'
    ) {
      const messageId = `step-${serial++}`;
      if (event.type === 'text') {
        lastText = event.text;
        lastMessageId = messageId;
      }
      emit({
        type: 'message.completed',
        messageId,
        role: 'assistant',
        text: event.type === 'text' ? event.text : '',
        ...(event.type === 'thinking'
          ? { thinking: event.text }
          : { phase: 'commentary' }),
      });
    } else if (
      event.type === 'final' &&
      sessionId !== undefined &&
      event.sessionId === sessionId &&
      typeof event.text === 'string' &&
      event.reason &&
      typeof event.reason === 'object' &&
      !Array.isArray(event.reason) &&
      event.reason.kind === 'completed'
    ) {
      emit({
        type: 'message.completed',
        messageId:
          event.text === lastText && lastMessageId ? lastMessageId : 'final',
        role: 'assistant',
        text: event.text,
        phase: 'final_answer',
      });
    } else if (
      event.type === 'tool_call' &&
      typeof event.callId === 'string' &&
      typeof event.tool === 'string'
    )
      emit({
        type: 'tool.started',
        toolCallId: event.callId,
        name: event.tool,
        input: event.input ?? null,
      });
    else if (event.type === 'tool_result' && typeof event.callId === 'string')
      emit({
        type: 'tool.completed',
        toolCallId: event.callId,
        output: event.result ?? null,
        status: event.status === 'error' ? 'failed' : 'succeeded',
      });
    else if (
      event.type === 'status' &&
      event.phase === 'step_end' &&
      event.usage !== undefined
    )
      emit({
        type: 'usage.reported',
        usageId: `step-${event.turn}-${event.step}`,
        scope: 'step',
        mode: 'incremental',
        values: { usage: event.usage },
      });
  };
}
