import type {
  AgentObservation,
  EventPipeline,
  JsonObject,
  Operation,
} from '../../../contracts/index.js';
import { AgentOutputError } from '../../../contracts/runtime/errors.js';
import {
  agentContract,
  type AgentInput,
} from '../../../contracts/plugin-types/agent.js';
import { agentObservationSchema } from '../../../contracts/models/agent-record.js';
import {
  parseConfig,
  validate,
  validateSchemaDefinition,
} from '../../../shared/schema.js';
import { object } from '../../../shared/json.js';
import { agentProjectDirectory } from '../../storage/workspaces.js';
import { FileAgentRecorder } from '../../storage/agent-records.js';

/** Installed by the registry for every Agent. Plugins need only execute/dispose. */
export function managedAgentOperation(
  operation: Operation,
  backend: string,
  timeout?: number,
): Operation {
  const active = new Map<AbortController, Promise<JsonObject>>();
  return {
    async execute(input, context) {
      const request = parseConfig<AgentInput>(
        agentContract.input_schema,
        input,
        'Agent input',
      );
      validateSchemaDefinition(request.outputSchema, 'Agent outputSchema');
      context.signal.throwIfAborted();
      const directory = agentProjectDirectory(
        await context.workspaces.read(request.projectRef),
      );
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(
              () =>
                controller.abort(new Error(`${backend} execution timed out`)),
              timeout,
            );
      const execution = (async (): Promise<JsonObject> => {
        const recorder = new FileAgentRecorder(context.directory, {
          version: 1,
          backend,
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
        // Native detail is optional call-local telemetry. The framework still records
        // input/result/failure when a plugin emits no observations at all.
        const emit = ((...args: unknown[]): unknown => {
          const index = typeof args[0] === 'string' ? 0 : 1;
          if (args[index] === 'rsi/agent-observation') {
            let observation: AgentObservation;
            try {
              observation = parseConfig<AgentObservation>(
                agentObservationSchema,
                args[index + 1],
                'Agent observation',
              );
            } catch (error) {
              record({
                runId: 'main',
                event: {
                  type: 'observation.gap',
                  reason:
                    error instanceof Error ? error.message : String(error),
                },
              });
              return;
            }
            record(observation);
            return;
          }
          return Reflect.apply(context.event.emit, context.event, args);
        }) as EventPipeline['emit'];
        const scope = context.extend({
          directory,
          signal,
          event: { ...context.event, emit },
        });
        try {
          record({
            runId: 'main',
            event: { type: 'run.started', backend, parentRunId: null },
          });
          record({
            runId: 'main',
            event: {
              type: 'observation.gap',
              reason:
                'Native message, tool and child-session coverage depends on available backend observations.',
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
          const output = await operation.execute(input, scope);
          signal.throwIfAborted();
          let result: JsonObject;
          try {
            validate(request.outputSchema, output, 'Agent output');
            result = object(output);
          } catch (error) {
            throw new AgentOutputError(
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
          }
          record({
            runId: 'main',
            event: {
              type: 'message.completed',
              messageId: 'result',
              role: 'assistant',
              text: JSON.stringify(result),
              phase: 'structured_result',
            },
          });
          record({
            runId: 'main',
            event: { type: 'run.finished', status: 'completed' },
          });
          return result;
        } catch (error) {
          const unknown =
            error !== null &&
            typeof error === 'object' &&
            'status' in error &&
            error.status === 'unknown';
          const cause: unknown = unknown
            ? error
            : signal.aborted
              ? signal.reason
              : error;
          if (unknown) unconfirmed = cause;
          if (!recordingFailed) {
            try {
              record({
                runId: 'main',
                event: {
                  type: 'run.finished',
                  status: unknown
                    ? 'unknown'
                    : context.signal.aborted
                      ? 'cancelled'
                      : 'failed',
                  error: cause instanceof Error ? cause.message : String(cause),
                },
              });
            } catch (recordError) {
              if (!unknown) throw recordError;
            }
          }
          throw cause;
        } finally {
          try {
            recorder.close();
          } catch (error) {
            throw unconfirmed ?? error;
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
    ...(operation.canRetry
      ? { canRetry: operation.canRetry.bind(operation) }
      : {}),
    async dispose() {
      for (const controller of active.keys())
        controller.abort(new Error('Agent disposed'));
      await Promise.allSettled(active.values());
      await operation.dispose();
    },
  };
}

/** Validate framework-owned settings before a plugin factory acquires resources. */
export function agentExecutionTimeout(config: JsonObject): number | undefined {
  const timeout = config.executionTimeoutMs;
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 2147483647)
  )
    throw new Error(
      'Agent executionTimeoutMs must be an integer from 1 to 2147483647',
    );
  return timeout;
}
