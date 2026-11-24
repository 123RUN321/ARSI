import type {
  AgentObservation,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { object } from '../../shared/json.js';

export function codexObservations(
  record: (event: AgentObservation) => void,
): (message: JsonObject, mainThread: string) => void {
  const children = new Set<string>();
  const activities = new Set<string>();
  const relationships = new Map<
    string,
    { parentRunId: string; role?: string; name?: string }
  >();
  const linkChild = (
    child: string,
    parent: string,
    mainThread: string,
    identity: { role?: string; name?: string } = {},
  ): void => {
    if (!parent || child === mainThread || child === parent) return;
    const existing = relationships.get(child);
    if (
      existing &&
      (!identity.role || identity.role === existing.role) &&
      (!identity.name || identity.name === existing.name)
    )
      return;
    const relationship = {
      parentRunId: parent === mainThread ? 'main' : parent,
      ...existing,
      ...identity,
    };
    relationships.set(child, relationship);
    if (children.has(child))
      record({
        runId: child,
        native: { sessionId: child },
        event: { type: 'run.linked', ...relationship },
      });
  };
  return (message, mainThread) => {
    if (
      !message.params ||
      typeof message.params !== 'object' ||
      Array.isArray(message.params)
    )
      return;
    const params = object(message.params);
    const started =
      message.method === 'thread/started' ? object(params.thread) : {};
    const item =
      params.item &&
      typeof params.item === 'object' &&
      !Array.isArray(params.item)
        ? object(params.item)
        : undefined;
    const collaboration =
      item?.type === 'collabAgentToolCall' || item?.type === 'collabToolCall';
    const thread =
      typeof started.id === 'string'
        ? started.id
        : collaboration && typeof item.senderThreadId === 'string'
          ? item.senderThreadId
          : typeof params.threadId === 'string'
            ? params.threadId
            : mainThread;
    const runId =
      thread && mainThread && thread !== mainThread ? thread : 'main';
    if (
      typeof started.id === 'string' &&
      typeof started.parentThreadId === 'string'
    )
      linkChild(started.id, started.parentThreadId, mainThread, {
        ...(typeof started.agentRole === 'string' && started.agentRole
          ? { role: started.agentRole }
          : {}),
        ...(typeof started.agentNickname === 'string' && started.agentNickname
          ? { name: started.agentNickname }
          : {}),
      });
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
          parentRunId: null,
          ...relationships.get(runId),
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
    if (message.method === 'turn/completed') {
      const turn = object(params.turn);
      record({
        runId,
        native: {
          ...native,
          ...(typeof turn.id === 'string' ? { turnId: turn.id } : {}),
        },
        event: {
          type: 'run.finished',
          ...(typeof turn.status === 'string'
            ? { nativeStatus: turn.status }
            : {}),
          status:
            turn.status === 'completed'
              ? 'completed'
              : turn.status === 'interrupted'
                ? 'cancelled'
                : turn.status === 'failed'
                  ? 'failed'
                  : 'unknown',
          ...(turn.error ? { error: JSON.stringify(turn.error) } : {}),
        },
      });
      return;
    }
    if (
      message.method !== 'item/started' &&
      message.method !== 'item/completed'
    )
      return;
    if (typeof item?.id !== 'string') return;
    const completed = message.method === 'item/completed';
    if (item.type === 'subAgentActivity') {
      const { kind, agentThreadId, agentPath } = item;
      if (
        typeof agentThreadId !== 'string' ||
        (kind !== 'started' &&
          kind !== 'interacted' &&
          kind !== 'interrupted' &&
          kind !== 'completed')
      )
        return;
      const activityId = `${thread}:${item.id}`;
      if (activities.has(activityId)) return;
      activities.add(activityId);
      if (kind === 'started') {
        const name =
          typeof agentPath === 'string'
            ? agentPath.split('/').at(-1)
            : undefined;
        linkChild(agentThreadId, thread, mainThread, name ? { name } : {});
      }
      record({
        runId,
        native: { ...native, itemId: item.id },
        event: {
          type: 'subagent.activity',
          activity: kind,
          childRunId: agentThreadId,
          ...(typeof agentPath === 'string' ? { agentPath } : {}),
        },
      });
    } else if (
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
      const text = (value: JsonValue | undefined): string =>
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
      collaboration ||
      [
        'commandExecution',
        'fileChange',
        'mcpToolCall',
        'dynamicToolCall',
        'webSearch',
        'imageView',
      ].includes(String(item.type))
    ) {
      if (
        collaboration &&
        item.tool === 'spawnAgent' &&
        Array.isArray(item.receiverThreadIds)
      )
        for (const child of item.receiverThreadIds)
          if (typeof child === 'string') linkChild(child, thread, mainThread);
      if (!completed)
        emit({
          type: 'tool.started',
          toolCallId: item.id,
          name: typeof item.tool === 'string' ? item.tool : String(item.type),
          input: item,
        });
      else {
        const { startedAtMs, completedAtMs } = item;
        emit({
          type: 'tool.completed',
          toolCallId: item.id,
          ...(collaboration && typeof item.tool === 'string'
            ? { name: item.tool }
            : {}),
          output: item,
          status:
            item.status === 'failed' || item.error
              ? 'failed'
              : item.status === 'completed'
                ? 'succeeded'
                : 'unknown',
          ...(typeof startedAtMs === 'number' &&
          typeof completedAtMs === 'number' &&
          completedAtMs >= startedAtMs
            ? { durationMs: completedAtMs - startedAtMs }
            : {}),
        });
      }
    }
  };
}
