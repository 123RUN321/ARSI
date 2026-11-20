import type { JsonValue, JsonObject } from '../../../src/contracts/json.js';
import type { CallTrace } from '../../../src/contracts/observation.js';

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
/** Native adapters provide stable IDs. The UI projects these events without backend branches. */
export function traceRows(events: CallTrace['items']): TraceRow[] {
  const rows: TraceRow[] = [];
  const messages = new Map<string, TraceRow>();
  const tools = new Map<string, TraceRow>();
  let step = 0;
  for (const record of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const event = eventObject(record.event);
    const runId = record.runId;
    const row: TraceRow = {
      id: String(record.sequence),
      runId,
      step,
      kind: 'event',
      title: record.type,
      summary: '',
      status: 'Recorded',
      at: record.at,
      duration: null,
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
        target.step = ++step;
        target.title = event.role === 'user' ? 'Task input' : 'Response';
        if (runId !== 'main') target.title += ` · ${runId}`;
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
            : eventText(target.result) || JSON.stringify(target.args ?? {});
    } else {
      row.body = JSON.stringify(event, null, 2);
      row.summary =
        event.type === 'observation.gap'
          ? String(event.reason)
          : event.type === 'run.started'
            ? `${runId}${typeof event.parentRunId === 'string' ? ` ← ${event.parentRunId}` : ''}`
            : event.type === 'run.finished'
              ? String(event.status)
              : 'Execution event';
      if (event.type === 'run.finished' && event.status === 'failed')
        row.status = 'Failed';
      rows.push(row);
    }
  }
  return rows;
}
