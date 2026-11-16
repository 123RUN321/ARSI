import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type AgentInput = {
  goal: string;
  projectRef: string;
  mode: 'analyze' | 'edit';
  requirements?: { delegation?: boolean };
  outputSchema: JsonObject;
};

export type AgentOutput = JsonObject;

export const agentContract = defineContract({
  id: 'contract.agent',
  input_schema: {
    additionalProperties: false,
    properties: {
      projectRef: { type: 'string', minLength: 1 },
      mode: { enum: ['analyze', 'edit'] },
      requirements: {
        type: 'object',
        additionalProperties: false,
        properties: { delegation: { type: 'boolean' } },
      },
      goal: { type: 'string' },
      outputSchema: { type: 'object' },
    },
    required: ['goal', 'projectRef', 'mode', 'outputSchema'],
    type: 'object',
  },
  output_schema: { type: 'object' },
});
