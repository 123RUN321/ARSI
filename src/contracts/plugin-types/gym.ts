import { defineContract } from '../contract.js';

export type GymInput =
  | {
      action: 'evaluate';
      candidateRef: string;
      taskIds: string[];
    }
  | {
      action: 'promote';
      candidateRef: string;
      incumbentRef: string;
    };

export type GymOutput =
  | {
      action: 'evaluate';
      measurementRef: string;
    }
  | {
      action: 'promote';
      decision: 'promote' | 'keep-incumbent' | 'reject';
      reason: string;
      promotionRef: string;
    };

export const gymContract = defineContract({
  id: 'contract.gym',
  input_schema: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { const: 'evaluate' },
          candidateRef: { type: 'string', minLength: 1 },
          taskIds: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
          },
        },
        required: ['action', 'candidateRef', 'taskIds'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { const: 'promote' },
          candidateRef: { type: 'string', minLength: 1 },
          incumbentRef: { type: 'string', minLength: 1 },
        },
        required: ['action', 'candidateRef', 'incumbentRef'],
      },
    ],
  },
  output_schema: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { const: 'evaluate' },
          measurementRef: { type: 'string', minLength: 1 },
        },
        required: ['action', 'measurementRef'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { const: 'promote' },
          decision: {
            enum: ['promote', 'keep-incumbent', 'reject'],
          },
          reason: { type: 'string', minLength: 1 },
          promotionRef: { type: 'string', minLength: 1 },
        },
        required: ['action', 'decision', 'reason', 'promotionRef'],
      },
    ],
  },
});
