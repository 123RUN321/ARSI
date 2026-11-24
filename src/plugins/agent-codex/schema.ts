import type { JsonSchema } from '../../contracts/index.js';

export type AgentCodexConfig = {
  executable?: string;
  model?: string;
  thinkingLevel?: string;
  timeoutMs?: number;
};

export const defaultExecutable = 'codex';

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: defaultExecutable },
    model: { type: 'string', minLength: 1, pattern: '\\S' },
    thinkingLevel: { type: 'string', minLength: 1, pattern: '\\S' },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
  },
};
