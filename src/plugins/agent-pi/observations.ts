import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentObservation } from '../../contracts/index.js';
import { object } from '../../shared/json.js';

export function piObservations(
  record: (event: AgentObservation) => void,
  runId: string,
): (value: AgentSessionEvent) => void {
  let serial = 0;
  return (value) => {
    const event = object(JSON.parse(JSON.stringify(value)));
    const emit = (observation: AgentObservation['event']): void =>
      record({ runId, event: observation });
    if (event.type === 'message_end') {
      const message = object(event.message);
      const content = Array.isArray(message.content)
        ? message.content.map((block) => object(block))
        : [];
      emit({
        type: 'message.completed',
        messageId: `message-${serial++}`,
        role: String(message.role),
        text: content
          .filter((block) => block.type === 'text')
          .map((block) => String(block.text))
          .join(''),
        thinking: content
          .filter((block) => block.type === 'thinking')
          .map((block) => String(block.thinking))
          .join(''),
      });
      if (message.usage !== undefined)
        emit({
          type: 'usage.reported',
          usageId: `message-${serial}`,
          scope: 'message',
          mode: 'incremental',
          values: object(message.usage),
        });
    } else if (
      event.type === 'tool_execution_start' &&
      typeof event.toolCallId === 'string'
    )
      emit({
        type: 'tool.started',
        toolCallId: event.toolCallId,
        name: String(event.toolName),
        input: event.args ?? null,
      });
    else if (
      event.type === 'tool_execution_end' &&
      typeof event.toolCallId === 'string'
    )
      emit({
        type: 'tool.completed',
        toolCallId: event.toolCallId,
        name: String(event.toolName),
        output: event.result ?? null,
        status: event.isError ? 'failed' : 'succeeded',
      });
  };
}
