import { defineContract } from '../contract.js';

export type InferencebenchInput = {
  candidateRef: string;
  concurrency?: number;
  /** The Runtime hashes this input to distinguish repeated samples in the same parent call. */
  sampleId?: string;
};

export type InferencebenchOutput = { measurementRef: string };

export const inferencebenchContract = defineContract({
  id: 'contract.inferencebench',
  input_schema: {
    additionalProperties: false,
    properties: {
      candidateRef: { minLength: 1, type: 'string' },
      concurrency: { type: 'integer', minimum: 1 },
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
