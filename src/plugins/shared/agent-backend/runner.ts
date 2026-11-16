import { agentOutput } from './output.js';
import { dirname } from 'node:path';
import type {
  AgentCapabilities,
  AgentInput,
  AgentObservation,
  AgentOutput,
  AgentProcessLauncher,
  RuntimeContext,
} from '../../../contracts/index.js';
import { object, json } from '../../../shared/json.js';
import { validateSchemaDefinition } from '../../../shared/schema.js';

export interface AgentSession {
  request: AgentInput;
  directory: string;
  signal: AbortSignal;
  launch: AgentProcessLauncher;
  record(observation: AgentObservation): void;
}

/** Each plugin owns its protocol. This runner owns only a single task lifecycle. */
export function agentBackend(options: {
  id: string;
  capabilities: AgentCapabilities;
  timeoutMs?: number;
  run(session: AgentSession, context: RuntimeContext): Promise<unknown>;
}): {
  execute(request: AgentInput, context: RuntimeContext): Promise<AgentOutput>;
  dispose(): Promise<void>;
} {
  const active = new Map<AbortController, Promise<AgentOutput>>();
  return {
    async execute(request, context) {
      json(request);
      validateSchemaDefinition(request.outputSchema, 'Agent outputSchema');
      if (request.mode === 'edit' && !options.capabilities.edit)
        throw new Error(`${options.id} does not support editing`);
      if (request.requirements?.delegation && !options.capabilities.delegation)
        throw new Error(`${options.id} does not support native delegation`);
      if (
        !options.capabilities.hardModelCallLimit &&
        (context.agentLimits?.modelCalls !== undefined ||
          context.scope?.limits.modelCalls !== undefined)
      )
        throw new Error(
          `${options.id} cannot enforce the configured modelCalls budget`,
        );
      context.signal.throwIfAborted();
      const workspace = await context.workspaces.read(request.projectRef);
      if (!workspace.project)
        throw new Error('Agent requires an authorized project');
      const directory = dirname(workspace.directory);
      if (context.agentProject !== directory)
        throw new Error('Agent project has not been authorized by Runtime');
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(
              () =>
                controller.abort(
                  new Error(`${options.id} execution timed out`),
                ),
              options.timeoutMs,
            );
      timer?.unref();
      const execution = (async (): Promise<AgentOutput> => {
        const recorder = context.openAgentRecord({
          version: 1,
          backend: options.id,
          capabilities: options.capabilities,
          input: object(request),
        });
        let recordingFailed = false;
        let unconfirmed: unknown;
        const record = (observation: AgentObservation): void => {
          try {
            recorder.record(observation);
          } catch (error) {
            recordingFailed = true;
            controller.abort(error);
            throw error;
          }
        };
        try {
          record({
            runId: 'main',
            event: {
              type: 'run.started',
              backend: options.id,
              parentRunId: null,
            },
          });
          const gaps = Object.entries(options.capabilities.observation).filter(
            ([, coverage]) => coverage !== 'complete',
          );
          if (gaps.length)
            record({
              runId: 'main',
              event: {
                type: 'observation.gap',
                reason: gaps
                  .map(([name, coverage]) => `${name}: ${coverage}`)
                  .join('; '),
              },
            });
          record({
            runId: 'main',
            event: {
              type: 'message.completed',
              messageId: 'task',
              role: 'user',
              text: request.goal,
            },
          });
          const output = await options.run(
            {
              request,
              directory,
              signal,
              record,
              launch: (spec, onLine) =>
                context.extend({ signal }).runAgentProcess(spec, onLine),
            },
            context.extend({ signal }),
          );
          signal.throwIfAborted();
          const result = agentOutput(request.outputSchema, output);
          record({
            runId: 'main',
            event: { type: 'run.finished', status: 'completed' },
          });
          return result;
        } catch (error) {
          const unknownStop =
            error !== null &&
            typeof error === 'object' &&
            'status' in error &&
            error.status === 'unknown';
          const cause: unknown = unknownStop
            ? error
            : signal.aborted
              ? signal.reason
              : error;
          if (unknownStop) unconfirmed = cause;
          if (!recordingFailed) {
            try {
              record({
                runId: 'main',
                event: {
                  type: 'run.finished',
                  status: unknownStop
                    ? 'unknown'
                    : context.signal.aborted
                      ? 'cancelled'
                      : 'failed',
                  error: cause instanceof Error ? cause.message : String(cause),
                },
              });
            } catch (recordError) {
              if (!unknownStop) throw recordError;
            }
          }
          throw cause;
        } finally {
          try {
            try {
              recorder.close();
            } catch (closeError) {
              throw unconfirmed ?? closeError;
            }
          } finally {
            clearTimeout(timer);
          }
        }
      })();
      active.set(controller, execution);
      try {
        return await execution;
      } finally {
        active.delete(controller);
        clearTimeout(timer);
      }
    },
    async dispose() {
      const executions = [...active.entries()];
      for (const [controller] of executions)
        controller.abort(new Error('Agent disposed'));
      await Promise.allSettled(executions.map(([, execution]) => execution));
    },
  };
}

export function nativeCapabilities(delegation: boolean): AgentCapabilities {
  return {
    edit: true,
    delegation,
    hardModelCallLimit: false,
    observation: {
      messages: 'complete',
      tools: 'partial',
      children: 'partial',
      thinking: 'partial',
    },
  };
}
