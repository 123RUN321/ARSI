import type { JsonObject } from '../../contracts/index.js';

export type GymReleaseMetric = 'successRate' | 'meanReward';

export type GymReleaseConfig = {
  baseUrl: string;
  promotionDefaults: {
    adapter: string;
    benchmark: string;
    seed: number;
    datasetVersion?: string;
    budget?: { timeoutS?: number };
  };
  poll?: { intervalMs?: number; timeoutMs?: number };
  minDelta?: number;
  metric?: GymReleaseMetric;
};

const text = { type: 'string', minLength: 1 };

export const releaseConfigSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseUrl: {
      ...text,
      description: 'eval_service base URL, for example http://127.0.0.1:8411',
    },
    promotionDefaults: {
      type: 'object',
      additionalProperties: false,
      properties: {
        adapter: {
          ...text,
          description:
            'Gym harness adapter. Gym owns harness selection; RSI only names it.',
        },
        benchmark: text,
        seed: { type: 'integer' },
        datasetVersion: text,
        budget: {
          type: 'object',
          additionalProperties: false,
          properties: {
            timeoutS: { type: 'integer', minimum: 1 },
          },
        },
      },
      required: ['adapter', 'benchmark', 'seed'],
    },
    poll: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intervalMs: { type: 'integer', minimum: 100 },
        timeoutMs: { type: 'integer', minimum: 1000 },
      },
    },
    minDelta: { type: 'number', minimum: 0, default: 0 },
    metric: {
      enum: ['successRate', 'meanReward'],
      default: 'successRate',
      description:
        'Effective holdout objective; successRate uses pass_rate and meanReward uses reward_mean.',
    },
  },
  required: ['baseUrl', 'promotionDefaults'],
};
