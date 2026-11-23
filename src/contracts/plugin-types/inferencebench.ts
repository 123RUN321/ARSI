import { defineContract } from '../contract.js';

export type InferencebenchInput = {
  candidateRef: string;
  concurrency?: number;
  /** Distinguishes physical samples within the caller's replay scope. */
  sampleId?: string;
  /** Return recorded benchmark failures to a supervising Policy or Evaluator. */
  returnFailedMeasurement?: boolean;
};

export type InferencebenchOutput = { measurementRef: string };

export const inferencebenchContract = defineContract({
  id: 'contract.inferencebench',
  input_schema: {
    additionalProperties: false,
    properties: {
      candidateRef: { minLength: 1, type: 'string' },
      concurrency: { type: 'integer', minimum: 1 },
      returnFailedMeasurement: { type: 'boolean' },
      sampleId: { type: 'string', minLength: 1 },
    },
    required: ['candidateRef'],
    type: 'object',
  },
  output_schema: {
    additionalProperties: false,
    properties: {
      measurementRef: { minLength: 1, type: 'string' },
    },
    required: ['measurementRef'],
    type: 'object',
  },
});
