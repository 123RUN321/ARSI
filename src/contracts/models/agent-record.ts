import { recordSchema } from './measurement.js';
import type { JsonObject, JsonValue } from '../json.js';

export type AgentEvent =
  | {
      type: 'subagent.activity';
      activity: 'started' | 'interacted' | 'interrupted' | 'completed';
      childRunId: string;
      agentPath?: string;
      /** Readable message sent by the parent, when reported by the backend. */
      text?: string;
    }
  | {
      type: 'run.started';
      parentRunId: string | null;
      backend: string;
      role?: string;
      name?: string;
    }
  | { type: 'run.linked'; parentRunId: string; role?: string; name?: string }
  | { type: 'task.submitted'; text: string; outputSchema: JsonObject }
  | { type: 'startup.retrying'; reason: string }
  | {
      type: 'session.started';
      sessionId: string;
      model?: string;
      version?: string;
    }
  | { type: 'message.appended'; messageId: string; text: string }
  | {
      type: 'message.completed';
      messageId: string;
      role: string;
      text: string;
      thinking?: string;
      phase?: string;
    }
  | { type: 'tool.started'; toolCallId: string; name: string; input: JsonValue }
  | {
      type: 'tool.completed';
      toolCallId: string;
      name?: string;
      output: JsonValue;
      status: 'succeeded' | 'failed' | 'unknown';
      durationMs?: number;
    }
  | {
      type: 'usage.reported';
      usageId: string;
      scope: string;
      mode: 'cumulative' | 'incremental';
      values: JsonObject;
    }
  | { type: 'observation.gap'; reason: string }
  | {
      type: 'run.finished';
      status: 'completed' | 'failed' | 'cancelled' | 'unknown';
      nativeStatus?: string;
      error?: string;
    };

export type AgentObservation = {
  runId: string;
  native?: { sessionId?: string; turnId?: string; itemId?: string };
  event: AgentEvent;
};
export interface AgentPayload {
  ref: string;
  bytes: number;
}
export interface AgentRecord {
  sequence: number;
  type: AgentEvent['type'];
  recordedAt: string;
  runId: string;
  native?: AgentObservation['native'];
  event: AgentEvent;
  payload: AgentPayload | null;
}

const text = { type: 'string' };
const value = {};
export const agentObservationSchema = recordSchema(
  {
    runId: { type: 'string', minLength: 1 },
    native: recordSchema({ sessionId: text, turnId: text, itemId: text }, []),
    event: {
      oneOf: [
        recordSchema(
          {
            type: { const: 'subagent.activity' },
            activity: {
              enum: ['started', 'interacted', 'interrupted', 'completed'],
            },
            childRunId: text,
            agentPath: text,
            text,
          },
          ['type', 'activity', 'childRunId'],
        ),
        recordSchema(
          {
            type: { const: 'run.started' },
            parentRunId: { type: ['string', 'null'] },
            backend: text,
            role: text,
            name: text,
          },
          ['type', 'parentRunId', 'backend'],
        ),
        recordSchema({
          type: { const: 'task.submitted' },
          text,
          outputSchema: { type: 'object' },
        }),
        recordSchema(
          {
            type: { const: 'run.linked' },
            parentRunId: text,
            role: text,
            name: text,
          },
          ['type', 'parentRunId'],
        ),
        recordSchema({ type: { const: 'startup.retrying' }, reason: text }),
        recordSchema(
          {
            type: { const: 'session.started' },
            sessionId: text,
            model: text,
            version: text,
          },
          ['type', 'sessionId'],
        ),
        recordSchema({
          type: { const: 'message.appended' },
          messageId: text,
          text,
        }),
        recordSchema(
          {
            type: { const: 'message.completed' },
            messageId: text,
            role: text,
            text,
            thinking: text,
            phase: text,
          },
          ['type', 'messageId', 'role', 'text'],
        ),
        recordSchema({
          type: { const: 'tool.started' },
          toolCallId: text,
          name: text,
          input: value,
        }),
        recordSchema(
          {
            type: { const: 'tool.completed' },
            toolCallId: text,
            name: text,
            output: value,
            status: { enum: ['succeeded', 'failed', 'unknown'] },
            durationMs: { type: 'number', minimum: 0 },
          },
          ['type', 'toolCallId', 'output', 'status'],
        ),
        recordSchema({
          type: { const: 'usage.reported' },
          usageId: text,
          scope: text,
          mode: { enum: ['cumulative', 'incremental'] },
          values: { type: 'object' },
        }),
        recordSchema({ type: { const: 'observation.gap' }, reason: text }),
        recordSchema(
          {
            type: { const: 'run.finished' },
            status: { enum: ['completed', 'failed', 'cancelled', 'unknown'] },
            nativeStatus: text,
            error: text,
          },
          ['type', 'status'],
        ),
      ],
    },
  },
  ['runId', 'event'],
);
