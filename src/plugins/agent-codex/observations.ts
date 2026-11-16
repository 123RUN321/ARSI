import type { AgentObservation, JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';

export function codexObservations(
  record: (event: AgentObservation) => void,
): (message: JsonObject, mainThread: string) => void {
  const children = new Set<string>();
  const parents = new Map<string, string>();
  return (message, mainThread) => {
    if (
      !message.params ||
      typeof message.params !== 'object' ||
      Array.isArray(message.params)
    )
      return;
    const params = object(message.params);
    const thread =
      typeof params.threadId === 'string' ? params.threadId : mainThread;
    const runId =
      thread && mainThread && thread !== mainThread ? thread : 'main';
    if (
      params.item &&
      typeof params.item === 'object' &&
      !Array.isArray(params.item)
    ) {
      const relation = object(params.item);
      if (relation.type === 'collabToolCall')
        for (const key of ['newThreadId', 'receiverThreadId']) {
          if (typeof relation[key] === 'string')
            parents.set(relation[key], runId);
        }
    }
    const native = {
      ...(thread ? { sessionId: thread } : {}),
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    };
    if (runId !== 'main' && !children.has(runId)) {
      children.add(runId);
      record({
        runId,
        native,
        event: {
          type: 'run.started',
          backend: 'agent.codex',
          parentRunId: parents.get(runId) ?? null,
        },
      });
    }
    const emit = (event: AgentObservation['event']): void =>
      record({ runId, native, event });
    if (
      message.method === 'item/agentMessage/delta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string'
    ) {
      emit({
        type: 'message.appended',
        messageId: params.itemId,
        text: params.delta,
      });
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      emit({
        type: 'usage.reported',
        usageId: `${thread}:tokens`,
        scope: 'session',
        mode: 'cumulative',
        values: object(params.tokenUsage),
      });
      return;
    }
    if (message.method === 'turn/completed' && runId !== 'main') {
      const turn = object(params.turn);
      emit({
        type: 'run.finished',
        status:
          turn.status === 'completed'
            ? 'completed'
            : turn.status === 'interrupted'
              ? 'cancelled'
              : 'failed',
        ...(turn.error ? { error: JSON.stringify(turn.error) } : {}),
      });
      return;
    }
    if (
      message.method !== 'item/started' &&
      message.method !== 'item/completed'
    )
      return;
    const item = object(params.item);
    if (typeof item.id !== 'string') return;
    const completed = message.method === 'item/completed';
    if (
      item.type === 'agentMessage' &&
      completed &&
      typeof item.text === 'string'
    )
      emit({
        type: 'message.completed',
        messageId: item.id,
        role: 'assistant',
        text: item.text,
        ...(typeof item.phase === 'string' ? { phase: item.phase } : {}),
      });
    else if (item.type === 'reasoning' && completed) {
      const text = (value: unknown): string =>
        Array.isArray(value)
          ? value.filter((v): v is string => typeof v === 'string').join('\n')
          : '';
      emit({
        type: 'message.completed',
        messageId: item.id,
        role: 'assistant',
        text: '',
        thinking: text(item.summary) || text(item.content),
      });
    } else if (
      [
        'commandExecution',
        'fileChange',
        'mcpToolCall',
        'dynamicToolCall',
        'collabToolCall',
        'webSearch',
        'imageView',
      ].includes(String(item.type))
    ) {
      if (!completed)
        emit({
          type: 'tool.started',
          toolCallId: item.id,
          name: typeof item.tool === 'string' ? item.tool : String(item.type),
          input: item,
        });
      else
        emit({
          type: 'tool.completed',
          toolCallId: item.id,
          output: item,
          status:
            item.status === 'failed' || item.error
              ? 'failed'
              : item.status === 'completed'
                ? 'succeeded'
                : 'unknown',
        });
    }
  };
}
