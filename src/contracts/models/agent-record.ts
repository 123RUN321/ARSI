import { recordSchema } from './measurement.js';
import type { JsonObject, JsonValue } from '../json.js';

export type AgentCoverage = 'complete' | 'partial' | 'unavailable';
export interface AgentCapabilities {
  edit: boolean;
  delegation: boolean;
  hardModelCallLimit: boolean;
  observation: {
    messages: AgentCoverage;
    tools: AgentCoverage;
    children: AgentCoverage;
    thinking: AgentCoverage;
  };
}
export type AgentEvent =
  | { type: 'run.started'; parentRunId: string | null; backend: string }
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
  terminal?: 'completed' | 'failed' | 'cancelled' | 'unknown';
  recordedAt: string;
  runId: string;
  native?: AgentObservation['native'];
  event: AgentEvent | null;
  payload: AgentPayload | null;
}
export interface AgentRecordPage {
  items: AgentRecord[];
  nextAfter: number;
  recording: 'open' | 'closed' | 'interrupted';
}
export interface AgentManifest {
  version: 1;
  backend: string;
  capabilities: AgentCapabilities;
  input: JsonObject;
}
export interface AgentRecorder {
  /** Append synchronously: a storage error must stop the producing execution. */
  record(observation: AgentObservation): void;
  close(): void;
}

const text = { type: 'string' };
const value = {};
export const agentObservationSchema = recordSchema(
  {
    runId: { type: 'string', minLength: 1 },
    native: recordSchema({ sessionId: text, turnId: text, itemId: text }, []),
    event: {
      oneOf: [
        recordSchema({
          type: { const: 'run.started' },
          parentRunId: { type: ['string', 'null'] },
          backend: text,
        }),
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
            error: text,
          },
          ['type', 'status'],
        ),
      ],
    },
  },
  ['runId', 'event'],
);
