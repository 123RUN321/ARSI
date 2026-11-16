import type { JsonSchema } from '../../contracts/index.js';

export type AgentDshConfig = {
  executable?: string;
  executionTimeoutMs?: number;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'dsh' },
    executionTimeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
};
