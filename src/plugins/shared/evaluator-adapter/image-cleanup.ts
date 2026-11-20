import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  cleanupImages,
  loadConfig,
  type ImageCleanupOptions,
} from 'arsi-evaluator';
import type {
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../../contracts/index.js';
import { errorText } from '../../../shared/errors.js';
import { digest, object, string } from '../../../shared/json.js';
import { clone, redact } from './data.js';

type CleanupContext = Pick<
  RuntimeContext,
  'experimentId' | 'bindingId' | 'dataDirectory' | 'facts' | 'signal'
>;
export type ImageCleanupSource =
  | {
      context: RuntimeContext;
      kind: 'agentbundle';
      workspaceRef: JsonValue | undefined;
    }
  | { context: RuntimeContext; kind: 'kernel' };

const callKey = /^(call-[0-9a-f]{32})(?:-([0-9a-f]{24}))?$/;

function configPath(
  context: CleanupContext,
  key: string,
  kind: ImageCleanupSource['kind'],
): string | undefined {
  const match = callKey.exec(key);
  if (!match) return undefined;
  return join(
    context.dataDirectory,
    'experiments',
    context.experimentId,
    'calls',
    match[1],
    ...(match[2] ? ['attempts', match[2]] : []),
    kind === 'kernel' ? 'sdk-config.json' : 'evaluator.json',
  );
}

function cleanupTarget(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  env: NodeJS.ProcessEnv,
): string {
  const location = (value: string | undefined) =>
    value ? resolve(value) : null;
  const { services: _services, ...settings } = loaded.experiment;
  return digest(
    clone({
      settings,
      deployment: loaded.deployment ?? null,
      home: homedir(),
      cache: location(env.EVALUATOR_CACHE_DIR),
      cacheHome: location(env.XDG_CACHE_HOME ?? env.LOCALAPPDATA),
      dockerHost: env.DOCKER_HOST ?? null,
      dockerContext: env.DOCKER_CONTEXT ?? null,
      dockerConfig: location(env.DOCKER_CONFIG),
      networkConfig: location(env.EVALUATOR_NETWORK_CONFIG),
    }),
  );
}

/** Journal the exact public input before the real SDK can acquire images. */
export async function recordImageCleanupInput(
  source: ImageCleanupSource,
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const { context, kind } = source;
  const key = context.idempotencyKey;
  // Standalone plugin callers provide their own directories and own their cleanup.
  if (path !== configPath(context, key, kind)) return;
  const input = await readFile(path, 'utf8');
  const loaded = await loadConfig(path, {}, env, { allowMissingAuth: true });
  if (loaded.experiment.environment.name !== 'docker') return;
  let ownerPath: string | null = null;
  if (source.kind === 'kernel') {
    ownerPath = join(context.directory, 'sdk-input', 'manifest.json');
  } else if (
    typeof source.workspaceRef === 'string' &&
    /^[0-9a-f-]{36}$/.test(source.workspaceRef)
  ) {
    const definition = await context.facts.read(
      'definitions',
      context.experimentId,
    );
    if (
      object(object(definition.recipe).application).plugin ===
      'application.agentbundle'
    )
      ownerPath = join(
        context.dataDirectory,
        'workspaces',
        source.workspaceRef,
        'files',
      );
  }
  await context.facts.write(`evaluator-images-${context.experimentId}`, key, {
    experimentId: context.experimentId,
    bindingId: context.bindingId,
    key,
    kind,
    ownerPath,
    inputDigest: digest(input),
    targetDigest: cleanupTarget(loaded, env),
    status: 'pending',
    attempts: [],
  });
}

function cleanupResult(value: unknown): {
  status: 'complete' | 'pending';
  report: JsonObject;
} {
  const report = object(value, 'Evaluator image cleanup report');
  if (
    typeof report.preview !== 'boolean' ||
    !Array.isArray(report.nodes) ||
    !report.nodes.length
  )
    throw new Error('Evaluator returned an invalid image cleanup report');
  let pending = report.preview;
  for (const raw of report.nodes) {
    const node = object(raw, 'cleanup node');
    if (
      typeof node.nodeId !== 'string' ||
      typeof node.daemonId !== 'string' ||
      !Array.isArray(node.items)
    )
      throw new Error('Invalid Evaluator image cleanup node');
    if (node.error !== undefined) pending = true;
    for (const rawItem of node.items) {
      const item = object(rawItem, 'cleanup item');
      if (
        typeof item.reference !== 'string' ||
        typeof item.imageId !== 'string' ||
        typeof item.reason !== 'string' ||
        !['candidate', 'deleted', 'retained', 'skipped', 'failed'].includes(
          String(item.status),
        )
      )
        throw new Error('Invalid Evaluator image cleanup item');
      if (item.status !== 'deleted' && item.status !== 'retained')
        pending = true;
    }
  }
  return {
    status: pending ? 'pending' : 'complete',
    report: object(redact(report)),
  };
}

/** Use the recorded call to identify the binding of older receipts. */
async function ownsBinding(
  context: CleanupContext,
  entry: JsonObject,
): Promise<boolean> {
  if (entry.bindingId !== undefined)
    return entry.bindingId === context.bindingId;
  const match = typeof entry.key === 'string' && callKey.exec(entry.key);
  if (!match) return false;
  try {
    const call = await context.facts.read('calls', match[1]);
    return (
      call.callId === match[1] &&
      call.experimentId === context.experimentId &&
      call.bindingId === context.bindingId
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

/** A retired instance can be disposed mid-experiment. Only the active binding sees the terminal event. */
export function evaluatorImageDisposer(
  context: RuntimeContext,
  ownerKind: ImageCleanupSource['kind'],
): () => Promise<void> {
  let succeeded = false;
  const unsubscribe = context.event?.on('rsi/experiment-finished', (event) => {
    if (event.experimentId === context.experimentId)
      succeeded = event.status === 'succeeded';
  });
  async function dispose(): Promise<void> {
    unsubscribe?.();
    if (!succeeded) return;
    const experiment = await context.facts.read(
      'experiments',
      context.experimentId,
    );
    if (
      experiment.id === context.experimentId &&
      experiment.status === 'succeeded'
    )
      await cleanupEvaluatorImages(
        context.extend({ signal: context.cleanup }),
        ownerKind,
      );
  }
  let disposal: Promise<void> | undefined;
  return () => (disposal ??= dispose());
}

export async function cleanupEvaluatorImages(
  context: CleanupContext,
  ownerKind: ImageCleanupSource['kind'],
  run: (options: ImageCleanupOptions) => Promise<unknown> = cleanupImages,
): Promise<void> {
  const kind = `evaluator-images-${context.experimentId}`;
  const receipts =
    context.facts.scan?.(kind) ?? (await context.facts.list(kind));
  for await (const entry of receipts) {
    if (
      entry.status !== 'pending' ||
      entry.experimentId !== context.experimentId ||
      entry.kind !== ownerKind ||
      !(await ownsBinding(context, entry))
    )
      continue;
    const key = string(entry.key);
    let outcome: JsonObject;
    try {
      context.signal.throwIfAborted();
      const path = configPath(context, key, ownerKind);
      if (!path) throw new Error('Invalid Evaluator cleanup call identity');
      if (digest(await readFile(path, 'utf8')) !== entry.inputDigest)
        throw new Error('Evaluator input changed after the recorded call');
      const loaded = await loadConfig(path, {}, process.env, {
        allowMissingAuth: true,
      });
      if (cleanupTarget(loaded, process.env) !== entry.targetDigest)
        throw new Error(
          'The resolved Evaluator configuration or inventory location changed since the recorded call',
        );
      const { experiment } = loaded;
      // These absolute paths participate in the SDK ownership fingerprint. A
      // custom/shared bundle cannot establish exclusive ownership for this experiment.
      const scope =
        entry.kind === 'kernel'
          ? experiment.benchmark.config.manifest
          : experiment.solver.config.path;
      if (
        typeof scope !== 'string' ||
        !isAbsolute(scope) ||
        scope !== entry.ownerPath
      )
        throw new Error(
          'Exclusive ownership of the Evaluator input could not be established',
        );
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(600_000),
      ]);
      outcome = cleanupResult(
        await run({
          configPath: path,
          execute: true,
          signal,
        }),
      );
      if (signal.aborted)
        outcome = {
          ...outcome,
          status: 'pending',
          error: errorText(signal.reason),
        };
    } catch (error) {
      outcome = { status: 'pending', error: errorText(error) };
    }
    if (!Array.isArray(entry.attempts))
      throw new Error('Invalid Evaluator cleanup receipt');
    await context.facts.write(kind, key, {
      ...entry,
      bindingId: context.bindingId,
      status: outcome.status,
      attempts: [
        ...entry.attempts,
        { at: new Date().toISOString(), ...outcome },
      ],
    });
    if (context.signal.aborted) break;
  }
}
