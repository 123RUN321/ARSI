import { AgentOutputError } from '../../../contracts/runtime/errors.js';
import type { JsonObject } from '../../../contracts/index.js';
import { object } from '../../../shared/json.js';

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
