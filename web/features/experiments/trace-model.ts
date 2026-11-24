import type { JsonValue, JsonObject } from '../../../src/contracts/json.js';
import type { CallTrace } from '../../../src/contracts/observation.js';
import { readAgentCollaboration } from '../../../src/shared/observation/agent-collaboration.js';

export interface TraceRow {
  id: string;
  runId: string;
  step: number;
  kind: 'model' | 'tool' | 'event';
  title: string;
  summary: string;
  status: string;
  at: string | null;
  duration: number | null;
  sessionId?: string;
  turnId?: string;
  childRunId?: string;
  delegationMessage?: string;
  thinking?: string;
  body?: string;
  args?: JsonValue;
  result?: JsonValue;
  payloadRefs?: string[];
}
export function eventObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
export function eventText(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map(eventText).filter(Boolean).join('\n\n');
  const item = eventObject(value);
  return typeof item.text === 'string'
    ? item.text
    : item.content
      ? eventText(item.content)
      : '';
}
function spawnedAgent(value: JsonValue | undefined): string | undefined {
  const item = readAgentCollaboration(value);
  if (item?.tool === 'spawnAgent' && item.targets.length === 1)
    return item.targets[0];
}

export function traceAgents(events: CallTrace['items']): Map<
  string,
  {
    label: string;
    parent: string | null;
  }
> {
  const agents = new Map<string, { label: string; parent: string | null }>();
  agents.set('main', { label: 'Main agent', parent: null });
  const identities = new Map<string, { name?: string; role?: string }>();
  for (const record of events) {
    const activity =
      record.type === 'subagent.activity' ? eventObject(record.event) : null;
    const childActivity =
      activity?.activity === 'started' &&
      typeof activity.childRunId === 'string'
        ? activity.childRunId
        : null;
    const delegatedRun =
      childActivity ??
      (record.type === 'tool.completed'
        ? spawnedAgent(eventObject(record.event).output)
        : undefined);
    const agentId = delegatedRun ?? record.runId;
    if (agentId === 'main') continue;
    let agent = agents.get(agentId);
    if (!agent) {
      agent = { label: `Subagent ${agents.size}`, parent: null };
      agents.set(agentId, agent);
    }
    if (delegatedRun) {
      agent.parent = record.runId;
      continue;
    }
    if (record.type !== 'run.started' && record.type !== 'run.linked') continue;
    const event = eventObject(record.event);
    if (typeof event.parentRunId === 'string') agent.parent = event.parentRunId;
    identities.set(record.runId, {
      ...identities.get(record.runId),
      ...(typeof event.name === 'string' && event.name.trim()
        ? { name: event.name.trim() }
        : {}),
      ...(typeof event.role === 'string' && event.role.trim()
        ? { role: event.role.trim() }
        : {}),
    });
  }
  const names = Array.from(identities).flatMap(([id, { role, name }]) => {
    const label = [name, role === name ? undefined : role]
      .filter(Boolean)
      .join(' · ');
    return label ? [{ id, label }] : [];
  });
  const occurrences = new Map<string, number>();
  for (const { label } of names)
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  for (const { id, label } of names) {
    const agent = agents.get(id)!;
    agent.label =
      occurrences.get(label) === 1 ? label : `${label} · ${agent.label}`;
  }
  return agents;
}

/** Native adapters provide stable IDs. The UI projects these events without backend branches. */
export function traceRows(events: CallTrace['items']): TraceRow[] {
  const rows: TraceRow[] = [];
  const messages = new Map<string, TraceRow>();
  const tools = new Map<string, TraceRow>();
  const steps = new Map<string, number>();
  for (const record of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const event = eventObject(record.event);
    const native = eventObject(record.native);
    const runId = record.runId;
    const row: TraceRow = {
      id: String(record.sequence),
      runId,
      step: steps.get(runId) ?? 0,
      kind: 'event',
      title: record.type,
      summary: '',
      status: 'Recorded',
      at: record.at,
      duration: null,
      ...(typeof native.sessionId === 'string'
        ? { sessionId: native.sessionId }
        : {}),
      ...(typeof native.turnId === 'string' ? { turnId: native.turnId } : {}),
    };
    const key = (id: JsonValue | undefined): string => `${runId}:${String(id)}`;
    if (
      event.type === 'message.appended' ||
      event.type === 'message.completed'
    ) {
      const messageKey = key(event.messageId);
      let target = messages.get(messageKey);
      if (!target) {
        target = row;
        target.kind = 'model';
        target.step += 1;
        steps.set(runId, target.step);
        target.title = event.role === 'user' ? 'Task input' : 'Response';
        messages.set(messageKey, target);
        rows.push(target);
      }
      if (record.payloadRef)
        (target.payloadRefs ??= []).push(record.payloadRef);
      target.body =
        event.type === 'message.appended'
          ? (target.body ?? '') + eventText(event.text)
          : eventText(event.text);
      if (typeof event.thinking === 'string') target.thinking = event.thinking;
      target.summary =
        target.body ||
        target.thinking ||
        (target.payloadRefs?.length
          ? 'Select to load the complete recorded content'
          : 'Recorded message');
      target.status =
        event.type === 'message.completed' ? 'Completed' : 'Streaming';
      if (event.type === 'message.completed' && event.phase === 'final_answer')
        target.title = 'Final response';
      else if (
        event.type === 'message.completed' &&
        event.phase === 'commentary'
      )
        target.title = 'Progress update';
    } else if (
      event.type === 'tool.started' ||
      event.type === 'tool.completed'
    ) {
      const toolKey = key(event.toolCallId);
      let target = tools.get(toolKey);
      if (!target) {
        target = row;
        target.kind = 'tool';
        target.title = typeof event.name === 'string' ? event.name : 'Tool';
        tools.set(toolKey, target);
        rows.push(target);
      }
      if (record.payloadRef)
        (target.payloadRefs ??= []).push(record.payloadRef);
      if (typeof event.name === 'string') target.title = event.name;
      if (event.type === 'tool.started') {
        target.args = event.input;
        target.status = 'Running';
      } else {
        if (typeof event.durationMs === 'number') {
          target.duration = event.durationMs / 1000;
        } else if (target.status === 'Running' && target.at && record.at) {
          const elapsed = Date.parse(record.at) - Date.parse(target.at);
          if (Number.isFinite(elapsed) && elapsed >= 0)
            target.duration = elapsed / 1000;
        }
        target.result = event.output;
        const child = spawnedAgent(event.output);
        if (child) target.childRunId = child;
        target.status =
          event.status === 'failed'
            ? 'Failed'
            : event.status === 'succeeded'
              ? 'Succeeded'
              : 'Unknown';
      }
      const args = eventObject(target.args);
      target.summary =
        typeof args.command === 'string'
          ? args.command
          : typeof args.path === 'string'
            ? args.path
            : (
                  readAgentCollaboration(target.args) ??
                  readAgentCollaboration(target.result)
                )?.tool === 'wait'
              ? 'Wait for subagents'
              : eventText(target.result) || JSON.stringify(target.args ?? {});
    } else if (
      event.type === 'subagent.activity' &&
      typeof event.childRunId === 'string'
    ) {
      row.childRunId = event.childRunId;
      row.title = `Subagent ${eventText(event.activity)}`;
      row.summary = eventText(event.agentPath);
      row.body = JSON.stringify(event, null, 2);
      if (typeof event.text === 'string' && event.text)
        row.delegationMessage = event.text;
      if (record.payloadRef) row.payloadRefs = [record.payloadRef];
      rows.push(row);
    } else {
      row.body = JSON.stringify(event, null, 2);
      row.summary =
        event.type === 'observation.gap' || event.type === 'startup.retrying'
          ? String(event.reason)
          : event.type === 'task.submitted'
            ? 'Task handed to the agent backend'
            : event.type === 'run.started' || event.type === 'run.linked'
              ? `${runId}${typeof event.parentRunId === 'string' ? ` ← ${event.parentRunId}` : ''}`
              : event.type === 'run.finished'
                ? [
                    event.status,
                    event.nativeStatus === event.status
                      ? null
                      : event.nativeStatus,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Execution event';
      if (event.type === 'run.finished' && typeof event.status === 'string')
        row.status =
          event.status.charAt(0).toUpperCase() + event.status.slice(1);
      rows.push(row);
    }
  }
  return rows;
}

export function traceMessageLabel(
  row: TraceRow,
  moreEvents: boolean,
  finished: boolean,
): { title: string; status: string } {
  if (row.kind !== 'model' || row.status !== 'Streaming') return row;
  if (moreEvents)
    return { title: 'Message preview', status: 'More events not loaded' };
  if (finished)
    return { title: 'Message preview', status: 'Completion not observed' };
  return { title: 'Streaming message', status: 'Streaming' };
}
