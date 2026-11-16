import type { JsonObject, JsonSchema } from '../../../contracts/index.js';
import { object } from '../../../shared/json.js';
import { validate } from '../../../shared/schema.js';

/** Invalid model results are distinct from launch, recording, and cleanup failures. */
export class AgentOutputError extends Error {}

export function agentOutput(schema: JsonSchema, value: unknown): JsonObject {
  try {
    validate(schema, value, 'Agent output');
    return object(value);
  } catch (error) {
    throw new AgentOutputError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

/** Decode the final model answer once; native protocol parsing stays in adapters. */
export function parseAgentResult(text: string): JsonObject {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  try {
    return object(JSON.parse(fenced?.[1] ?? trimmed));
  } catch (error) {
    throw new AgentOutputError('Agent final response must be a JSON object', {
      cause: error,
    });
  }
}
