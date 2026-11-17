import type { JsonSchema } from '../../contracts/index.js';

export type AgentDshConfig = {
  executable?: string;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'dsh' },
  },
};
