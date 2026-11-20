import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from 'arsi-evaluator';
import type {
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../../contracts/index.js';
import { errorText } from '../../../shared/errors.js';
import { digest, object, string } from '../../../shared/json.js';
import { runSdkCli } from './cli.js';
import { clone, redact } from './data.js';

type CleanupContext = Pick<
  RuntimeContext,
  'experimentId' | 'dataDirectory' | 'facts' | 'signal'
>;
export type ImageCleanupSource =
  | {
      context: RuntimeContext;
      kind: 'agentbundle';
      workspaceRef: JsonValue | undefined;
    }
  | { context: RuntimeContext; kind: 'kernel' };

function configPath(
  context: CleanupContext,
  key: string,
  kind: JsonValue,
): string | undefined {
  const match = /^(call-[0-9a-f]{32})(?:-([0-9a-f]{24}))?$/.exec(key);
  if (!match || (kind !== 'agentbundle' && kind !== 'kernel')) return undefined;
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

export async function cleanupEvaluatorImages(
  context: CleanupContext,
  run = runSdkCli,
): Promise<void> {
  const kind = `evaluator-images-${context.experimentId}`;
  const receipts =
    context.facts.scan?.(kind) ?? (await context.facts.list(kind));
  for await (const entry of receipts) {
    if (entry.status !== 'pending') continue;
    const key = string(entry.key);
    let outcome: JsonObject;
    try {
      context.signal.throwIfAborted();
      if (entry.experimentId !== context.experimentId)
        throw new Error('Evaluator cleanup experiment identity mismatch');
      const path = configPath(context, key, entry.kind);
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
          command: 'cleanup images',
          configPath: path,
          env: process.env,
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
      status: outcome.status,
      attempts: [
        ...entry.attempts,
        { at: new Date().toISOString(), ...outcome },
      ],
    });
    if (context.signal.aborted) break;
  }
}
