import type { JsonObject } from '../../contracts/index.js';

export type GymSplit = 'train_probe' | 'train_full';

export type GymTier = 'probe' | 'screen' | 'full';

/** Fixed request defaults; every evaluation under one binding shares them. */
export type GymRequestDefaults = {
  adapter: string;
  benchmark: string;
  split: GymSplit;
  tier: GymTier;
  seed: number;
  harnessManifest?: string;
};

export type GymConfig = {
  baseUrl: string;
  requestDefaults: GymRequestDefaults;
  poll?: { intervalMs?: number; timeoutMs?: number };
  budget?: { maxRollouts?: number; timeoutS?: number };
};

const text = { type: 'string', minLength: 1 };
const integer = { type: 'integer' };

function schema(split: JsonObject): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      baseUrl: {
        ...text,
        description: 'eval_service base URL, for example http://127.0.0.1:8411',
      },
      requestDefaults: {
        type: 'object',
        additionalProperties: false,
        properties: {
          adapter: {
            ...text,
            description:
              'Gym harness adapter. Gym owns harness selection; RSI only names it.',
          },
          benchmark: text,
          split,
          tier: { enum: ['probe', 'screen', 'full'] },
          seed: integer,
          harnessManifest: text,
        },
        required: ['adapter', 'benchmark', 'split', 'tier', 'seed'],
      },
      poll: {
        type: 'object',
        additionalProperties: false,
        properties: {
          intervalMs: { type: 'integer', minimum: 100 },
          timeoutMs: { type: 'integer', minimum: 1000 },
        },
      },
      budget: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxRollouts: { type: 'integer', minimum: 1 },
          timeoutS: { type: 'integer', minimum: 1 },
        },
      },
    },
    required: ['baseUrl', 'requestDefaults'],
  };
}

/** Holdout is not requestable through Gym's outer evaluation contract (OF-2). */
export const gymConfigSchema: JsonObject = schema({
  enum: ['train_probe', 'train_full'],
});
