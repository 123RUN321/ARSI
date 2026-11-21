import type { JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { gymConfigSchema, type GymConfig } from './evaluate/schema.js';
import {
  promotionConfigSchema,
  type GymPromotionConfig,
} from './promotion/schema.js';

export type GymPluginConfig =
  | ({ mode: 'evaluate' } & GymConfig)
  | ({ mode: 'promote' } & GymPromotionConfig);

function withMode(
  schema: JsonObject,
  mode: 'evaluate' | 'promote',
): JsonObject {
  const properties = object(schema.properties, `${mode} config.properties`);
  const required = Array.isArray(schema.required)
    ? schema.required.map((value) => String(value))
    : [];
  return {
    ...schema,
    properties: {
      ...properties,
      mode: { const: mode },
    },
    required: [...required, 'mode'],
  };
}

export const gymPluginConfigSchema: JsonObject = {
  type: 'object',
  oneOf: [
    withMode(gymConfigSchema, 'evaluate'),
    withMode(promotionConfigSchema, 'promote'),
  ],
};
