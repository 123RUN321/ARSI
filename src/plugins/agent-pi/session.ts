import { parseAgentResult } from '../shared/agent-backend/output.js';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentInput,
  AgentOutput,
  RuntimeContext,
} from '../../contracts/index.js';
import { json, object } from '../../shared/json.js';
import { createProjectSubagentTool, readProjectRole } from './subagent.js';
import { piObservations } from './observations.js';
import { projectTools } from './project-tools.js';
import {
  parseConfig,
  validate,
  validateSchemaDefinition,
} from '../../shared/schema.js';
import {
  configSchema,
  type AgentPiConfig,
  type ResolvedAgentPiConfig,
} from './schema.js';
function cwdForTemporary(request: PiTask): string {
  return join(request.cwd, 'scratch');
}

/** Resolve only for execution; persisted config keeps environment references. */
export function resolveModelConfig(
  config: AgentPiConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { model: string; base_url: string; api_key: string } {
  const settings = parseConfig<ResolvedAgentPiConfig>(
    configSchema,
    config,
    'agent.pi config',
  );
  const resolve = (field: 'model' | 'base_url' | 'api_key'): string => {
    const value = settings[field].replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, name: string) => {
        const replacement = environment[name];
        if (replacement === undefined)
          throw new Error(
            `agent.pi ${field} references missing environment variable ${name}`,
          );
        return replacement;
      },
    );
    if (!value.trim())
      throw new Error(`agent.pi ${field} resolved to an empty value`);
    return value;
  };
  return {
    model: resolve('model'),
    base_url: resolve('base_url'),
    api_key: resolve('api_key'),
  };
}
export type PiTask = AgentInput & {
  cwd: string;
  role?: string;
  runId: string;
  parentRunId: string | null;
};
export async function createPiSession(
  rawConfig: AgentPiConfig,
  delegate: (
    role: string,
    goal: string,
    parent: PiTask,
  ) => Promise<AgentOutput>,
): Promise<{
  execute(request: PiTask, context: RuntimeContext): Promise<AgentOutput>;
  dispose(): Promise<void>;
}> {
  const config = parseConfig<ResolvedAgentPiConfig>(
    configSchema,
    rawConfig,
    'agent.pi config',
  );
  if (config.maxTokens !== undefined && config.maxTokens > config.contextWindow)
    throw new Error('agent.pi maxTokens must not exceed contextWindow');
  const thinkingLevel = config.thinkingLevel;
  return {
    async execute(request, context) {
      json(request);
      const {
        model: modelName,
        base_url: endpoint,
        api_key: apiKey,
      } = resolveModelConfig(config);
      const signal = context.signal;
      signal.throwIfAborted();
      await mkdir(context.directory, { recursive: true });
      let directory: string | undefined;
      let session:
        | Awaited<ReturnType<typeof createAgentSession>>['session']
        | undefined;
      let unsubscribe: (() => void) | undefined;
      if (request.parentRunId !== null)
        context.agentRecorder!.record({
          runId: request.runId,
          event: {
            type: 'run.started',
            backend: 'agent.pi',
            parentRunId: request.parentRunId,
          },
        });
      const observe = piObservations(
        (event) => context.agentRecorder!.record(event),
        request.runId,
      );
      const record = (type: string, data: unknown): void => {
        if (type === 'error') observe({ type, data });
      };
      try {
        directory = await mkdtemp(join(cwdForTemporary(request), 'pi-'));
        signal.throwIfAborted();
        const runtime = await ModelRuntime.create({
          authPath: join(directory, 'auth.json'),
          modelsPath: null,
          modelsStorePath: join(directory, 'models.json'),
          allowModelNetwork: false,
          refreshOnCreate: false,
          signal,
        });
        runtime.registerProvider('rsi', {
          api: 'openai-completions',
          apiKey: 'rsi-runtime-credential',
          baseUrl: endpoint,
          models: [
            {
              id: modelName,
              name: modelName,
              reasoning: thinkingLevel !== 'off',
              thinkingLevelMap: { xhigh: 'xhigh' },
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: config.contextWindow,
              maxTokens: config.maxTokens ?? config.contextWindow,
            },
          ],
        });
        const model = runtime.getModel('rsi', modelName);
        if (!model) throw new Error('Configured Pi model unavailable');
        const schema = request.outputSchema;
        validateSchemaDefinition(schema, 'Agent outputSchema');
        const settingsManager = SettingsManager.inMemory({
          cacheWarming: 'off',
          compaction: {
            enabled: true,
            ...(config.maxTokens === undefined
              ? {}
              : { reserveTokens: config.maxTokens }),
          },
          retry: {
            enabled: config.retries > 0,
            maxRetries: config.retries,
            baseDelayMs: config.retryBaseDelayMs,
            provider: { maxRetries: 0 },
          },
        });
        const instructions =
          'Return only the JSON object matching outputSchema in your final response, without a result envelope or prose.';
        const cwd = await realpath(request.cwd);
        const agentDir = join(directory, 'agent');
        const path = join(cwd, 'AGENTS.md');
        const skills = join(cwd, '.agents', 'skills');
        const agentsFiles = [{ path, content: await readFile(path, 'utf8') }];
        if (request.role !== undefined)
          agentsFiles.push(await readProjectRole(cwd, request.role));
        const hasSkills = await lstat(skills).then(
          (stat) => stat.isDirectory(),
          () => false,
        );
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noThemes: true,
          additionalSkillPaths: hasSkills ? [skills] : [],
          agentsFilesOverride: () => ({ agentsFiles }),
          appendSystemPrompt: [],
          systemPrompt: instructions,
        });
        await resourceLoader.reload();
        const tools = projectTools(cwd);
        if (request.role === undefined) {
          const tool = await createProjectSubagentTool(cwd, (role, goal) =>
            delegate(role, goal, request),
          );
          if (tool) tools.push(tool);
        }
        ({ session } = await createAgentSession({
          cwd,
          agentDir,
          model,
          modelRuntime: runtime,
          thinkingLevel,
          customTools: tools,
          resourceLoader,
          sessionManager: SessionManager.inMemory(cwd),
          settingsManager,
        }));
        unsubscribe = session.subscribe((event) => {
          if (
            (event.type === 'message_end' &&
              event.message.role === 'assistant') ||
            event.type === 'tool_execution_start' ||
            event.type === 'tool_execution_end' ||
            event.type === 'auto_retry_start' ||
            event.type === 'auto_retry_end' ||
            event.type === 'compaction_start' ||
            event.type === 'compaction_end'
          )
            observe(event);
        });
        let callFailure: unknown;
        const original = session.agent.streamFunction;
        session.agent.streamFunction = async (m, c, o) => {
          signal.throwIfAborted();
          try {
            await context.charge('modelCalls', 1);
          } catch (error) {
            callFailure = error;
            session?.setAutoRetryEnabled(false);
            throw error;
          }
          signal.throwIfAborted();
          const controller = new AbortController();
          const requestSignal = AbortSignal.any([
            signal,
            ...(o?.signal ? [o.signal] : []),
            controller.signal,
          ]);
          const timer =
            config.timeoutMs === undefined
              ? undefined
              : setTimeout(
                  () =>
                    controller.abort(
                      new DOMException(
                        'Agent model request timed out',
                        'TimeoutError',
                      ),
                    ),
                  config.timeoutMs,
                );
          timer?.unref();
          const release = (): void => {
            clearTimeout(timer);
            requestSignal.removeEventListener('abort', release);
          };
          requestSignal.addEventListener('abort', release, { once: true });
          try {
            const stream = await original(m, c, {
              ...o,
              signal: requestSignal,
              apiKey,
              maxTokens: config.maxTokens,
              maxRetries: 0,
              timeoutMs: config.timeoutMs,
              onPayload:
                config.maxTokens === undefined
                  ? async (payload, model) => {
                      const configured =
                        (await o?.onPayload?.(payload, model)) ?? payload;
                      // Pi's simple stream adds a model-based default to the wire request.
                      if (configured === null || typeof configured !== 'object')
                        return configured;
                      const body = { ...configured };
                      Reflect.deleteProperty(body, 'max_tokens');
                      Reflect.deleteProperty(body, 'max_completion_tokens');
                      return body;
                    }
                  : o?.onPayload,
            });
            void stream.result().then((message) => {
              release();
              const statusText = /^(\d{3})\b/.exec(
                message.errorMessage ?? '',
              )?.[1];
              const status =
                statusText === undefined ? null : Number(statusText);
              // An explicit permanent HTTP status outranks transient-looking provider text.
              if (
                requestSignal.aborted ||
                (status !== null && status !== 429 && status < 500)
              )
                session?.setAutoRetryEnabled(false);
            }, release);
            return stream;
          } catch (error) {
            release();
            throw error;
          }
        };
        const cancel = () => {
          void session?.abort();
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          const prompt = JSON.stringify({
            goal: request.goal,
            outputSchema: schema,
          });
          const start = session.messages.length;
          await session.prompt(prompt, { expandPromptTemplates: false });
          await session.waitForIdle();
          signal.throwIfAborted();
          if (callFailure) throw callFailure;
          const message = session.messages
            .slice(start)
            .reverse()
            .find((item) => item.role === 'assistant');
          if (
            message?.role === 'assistant' &&
            (message.stopReason === 'error' || message.stopReason === 'aborted')
          )
            throw new Error(
              message.errorMessage ?? `Agent response ${message.stopReason}`,
            );
          const response =
            message?.role === 'assistant'
              ? message.content
                  .filter((item) => item.type === 'text')
                  .map((item) => item.text)
                  .join('')
              : '';
          const result = parseAgentResult(response);
          if (request.parentRunId !== null)
            validate(schema, result, 'Pi child output');
          if (request.parentRunId !== null)
            context.agentRecorder!.record({
              runId: request.runId,
              event: { type: 'run.finished', status: 'completed' },
            });
          return object(result);
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      } catch (error) {
        const cause: unknown = signal.aborted ? signal.reason : error;
        const message = cause instanceof Error ? cause.message : String(cause);
        record('error', { message });
        if (request.parentRunId !== null)
          context.agentRecorder!.record({
            runId: request.runId,
            event: {
              type: 'run.finished',
              status: signal.aborted ? 'cancelled' : 'failed',
              error: message,
            },
          });
        throw cause;
      } finally {
        unsubscribe?.();
        try {
          await session?.abort();
        } finally {
          try {
            session?.dispose();
          } finally {
            if (directory)
              await rm(directory, { recursive: true, force: true });
          }
        }
      }
    },
    async dispose() {},
  };
}
