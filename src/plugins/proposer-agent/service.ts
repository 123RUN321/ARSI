import type { AgentEditingConfig } from './schema.js';
import type {
  OperationDefinition,
  ProposerInput,
  ProposerOutput,
} from '../../contracts/index.js';
import { applicationContract } from '../../contracts/plugin-types/index.js';
import { json, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import {
  editEvidenceRefs,
  requestEdit,
  type ReadOnlyEditContext,
} from '../shared/agent-editing/index.js';
import { proposerExecutionContext } from './execution-context.js';
import { metricEvidence } from './metric-evidence.js';
import { editOutputSchema } from '../shared/agent-editing/index.js';

export const createProposerAgent: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  AgentEditingConfig
>['create'] = async (config, services) => {
  return {
    async execute(input, context) {
      json(input);
      const parent = await context.readCandidate(string(input.parent));
      const metadata = await context.applicationMetadata();
      // Runtime authorizes and sanitizes execution files before business projection.
      // Preserve the configured training-summary behavior for other Proposer users.
      let execution: ReadOnlyEditContext | undefined;
      if ((config.evidenceView ?? 'execution') === 'execution') {
        const full = object(
          await context.readEvidence(editEvidenceRefs(input), {
            format: 'files',
            view: 'execution',
          }),
        );
        execution = proposerExecutionContext(full);
      }
      if (config.evidenceView === 'training-summary') {
        execution = {
          files: {
            'context/metrics.json': JSON.stringify(
              await metricEvidence(editEvidenceRefs(input), context),
            ),
          },
          evidence: await context.readEvidence(editEvidenceRefs(input), {
            view: 'training-summary',
          }),
          input: {
            metricEvidencePath: 'context/metrics.json',
            metricEvidenceInstruction:
              'Read actual metric values, units and evaluator-provided environment summaries here before researching options. Missing metrics or environment fields are unknown; resource verification does not prove flag activation.',
          },
        };
      }
      if (input.maxCandidates === undefined) return commitProposal(0);
      const candidates: Extract<
        ProposerOutput,
        { status: 'batch' }
      >['candidates'] = [];
      const noChangeReasons: string[] = [];
      for (let index = 0; index < input.maxCandidates; index++) {
        const result = await commitProposal(index);
        if (result.status === 'created') {
          const { candidateRef, diffRef, rationale } = result;
          candidates.push({ candidateRef, diffRef, rationale });
        } else {
          noChangeReasons.push(result.rationale);
        }
      }
      if (candidates.length) return { status: 'batch', candidates };
      return {
        status: 'no-change',
        candidateRef: parent.ref,
        diffRef: null,
        rationale:
          noChangeReasons.join('\n\n') || 'No candidate changes were proposed.',
      };

      async function commitProposal(
        index: number,
      ): Promise<Exclude<ProposerOutput, { status: 'batch' }>> {
        const response = await requestEdit(
          config,
          { ...input, target: metadata.target, proposalIndex: index },
          parent.artifactRef,
          context.extend({
            directory: `${context.directory}/proposal-${index}`,
          }),
          execution,
          editOutputSchema,
          config.subagents ?? [],
        );
        try {
          const committed = await context.application({
            action: 'commit',
            parentCandidateRef: parent.ref,
            editRef: response.editRef,
            ...(input.editConstraints
              ? { editConstraints: input.editConstraints }
              : {}),
          });
          validate(
            applicationContract.output_schema,
            committed,
            'Application commit output',
          );
          if (committed.action !== 'commit')
            throw new Error('Application did not return a commit result');
          const candidateRef = string(committed.candidateRef);
          const rationale = string(response.result.reason);
          if (committed.status === 'created')
            return {
              status: 'created',
              candidateRef,
              diffRef: string(committed.diffRef),
              rationale,
            };
          if (committed.status !== 'no-change' || committed.diffRef !== null)
            throw new Error('Invalid no-change Application commit output');
          return {
            status: 'no-change',
            candidateRef,
            diffRef: null,
            rationale,
          };
        } finally {
          await services.workspaces.release(response.editRef);
        }
      }
    },
    async dispose() {},
  };
};
