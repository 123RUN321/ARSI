import type { JsonSchema } from '../../contracts/index.js';

export type AgentPiConfig = {
  model?: string;
  base_url?: string;
  api_key?: string;
  maxTokens?: number;
  contextWindow?: number;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  retries?: number;
  retryBaseDelayMs?: number;
  /** Per-model-request timeout in milliseconds. */
  timeoutMs?: number;
  executionTimeoutMs?: number;
};

export const configDefaults = {
  model: '${MODEL_NAME}',
  base_url: '${MODEL_ENDPOINT}',
  api_key: '${MODEL_API_KEY}',
  contextWindow: 262144,
  thinkingLevel: 'low',
  retries: 0,
  retryBaseDelayMs: 1000,
} satisfies Partial<AgentPiConfig>;

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    model: { type: 'string', minLength: 1, default: configDefaults.model },
    base_url: {
      type: 'string',
      minLength: 1,
      default: configDefaults.base_url,
    },
    api_key: {
      type: 'string',
      pattern: '^\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$',
      default: configDefaults.api_key,
    },
    maxTokens: { type: 'integer', minimum: 1 },
    contextWindow: {
      type: 'integer',
      minimum: 1,
      default: configDefaults.contextWindow,
    },
    thinkingLevel: {
      enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      default: configDefaults.thinkingLevel,
    },
    retries: {
      type: 'integer',
      minimum: 0,
      maximum: 10,
      default: configDefaults.retries,
    },
    retryBaseDelayMs: {
      type: 'integer',
      minimum: 0,
      maximum: 300000,
      default: configDefaults.retryBaseDelayMs,
    },
    executionTimeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647 },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
  },
  additionalProperties: false,
};
