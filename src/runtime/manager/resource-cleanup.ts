import type {
  CleanupContext,
  CleanupResult,
  FactStore,
  JsonObject,
  JsonSchema,
} from '../../contracts/index.js';
import { errorText } from '../../shared/errors.js';
import { json, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import type { Registry } from '../registry/index.js';
import { acquireResourceGate } from '../revisions/exclusion.js';
import { safeId } from '../storage/index.js';
import {
  assertDefinitionDigest,
  definitionArchiveId,
} from './definition-lock.js';
import { acquireExecutionLock } from './execution-lock.js';
import type { Manager } from './index.js';

type CleanupBinding = Pick<CleanupContext, 'bindingId' | 'pluginId'>;
type BindingCleanupResult = CleanupResult & CleanupBinding;
type ExperimentCleanupContext = Omit<CleanupContext, keyof CleanupBinding>;

export interface ExperimentCleanupReport {
  experimentId: string;
  dryRun: boolean;
  results: BindingCleanupResult[];
}

export class ExperimentInUseError extends Error {}

export function cleanupFacts(
  store: FactStore,
  ownership: AbortSignal,
  dryRun: boolean,
): FactStore {
  return {
    read: store.read.bind(store),
    list: store.list.bind(store),
    scan: store.scan?.bind(store),
    write(kind, id, value) {
      ownership.throwIfAborted();
      if (dryRun) throw new Error('Cleanup previews cannot write facts');
      return store.write(kind, id, value);
    },
  };
}

const resultSchema: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'status'],
    properties: {
      key: { type: 'string', minLength: 1 },
      status: { enum: ['complete', 'preview', 'pending'] },
      report: { type: 'object' },
      error: { type: 'string' },
    },
  },
};

/** Read only this experiment's saved Recipes, including effective Policy defaults. */
async function readCleanupBindings({
  facts,
  experimentId,
  signal,
}: ExperimentCleanupContext): Promise<CleanupBinding[]> {
  const bindings = new Map<string, CleanupBinding>();
  function add(bindingId: string, plugin: unknown): void {
    const pluginId = string(plugin, 'cleanup plugin ID');
    bindings.set(JSON.stringify([bindingId, pluginId]), {
      bindingId,
      pluginId,
    });
  }
  function addRecipe(recipe: JsonObject): void {
    add('_application', object(recipe.application).plugin);
    for (const [name, entry] of Object.entries(object(recipe.bindings ?? {})))
      add(name, object(entry).plugin);
  }

  let definition: JsonObject;
  try {
    definition = await facts.read('definitions', experimentId);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    // A run that failed before locking its definition can still have a saved Recipe.
    const { recipe } = await facts.read('experiments', experimentId);
    if (recipe !== undefined) addRecipe(object(recipe));
    return [...bindings.values()];
  }
  for (;;) {
    signal.throwIfAborted();
    assertDefinitionDigest(definition);
    addRecipe(object(definition.recipe));
    if (definition.reflection) {
      const { implementation } = object(definition.reflection);
      add('_reflection', object(implementation).ref);
    }
    if (definition.retry === undefined) break;
    const ref = string(
      object(definition.retry).previousDefinition,
      'previous definition',
    );
    definition = await facts.read('definition-attempts', ref);
    if (definitionArchiveId(experimentId, definition) !== ref)
      throw new Error(
        'Invalid archived definition for experiment ' + experimentId,
      );
  }
  return [...bindings.values()];
}

/** Each owner answers independently. Keep results collected before interruption. */
async function collectBindingCleanup(
  registry: Registry,
  context: ExperimentCleanupContext,
  results: BindingCleanupResult[],
): Promise<void> {
  for (const owner of await readCleanupBindings(context)) {
    if (context.signal.aborted) break;
    try {
      if (!registry.handles(owner.pluginId, 'rsi/cleanup')) continue;
      const entries = await registry.dispatch(owner.pluginId, 'rsi/cleanup', {
        ...context,
        ...owner,
      });
      validate(resultSchema, entries, 'Plugin cleanup results');
      const expected = context.dryRun ? 'preview' : 'complete';
      if (
        entries.some(
          (entry) => entry.status !== expected && entry.status !== 'pending',
        )
      )
        throw new Error(
          'Plugin cleanup result does not match the requested mode',
        );
      for (const entry of entries) {
        if (entry.report !== undefined) json(entry.report);
        results.push({ ...structuredClone(entry), ...owner });
      }
    } catch (error) {
      results.push({
        ...owner,
        key: owner.bindingId,
        status: 'pending',
        error: errorText(error),
      });
    }
  }
}

/** Resource results remain retryable independently of the saved business and instance disposal outcomes. */
export async function cleanAfterSuccess(
  registry: Registry,
  context: ExperimentCleanupContext,
): Promise<void> {
  const results: BindingCleanupResult[] = [];
  let error: string | undefined;
  try {
    await collectBindingCleanup(registry, context, results);
    context.signal.throwIfAborted();
  } catch (cause) {
    error = errorText(cause);
  }
  await context.facts.write('resource-cleanup', context.experimentId, {
    experimentId: context.experimentId,
    status:
      error !== undefined || results.some((entry) => entry.status === 'pending')
        ? 'pending'
        : 'complete',
    results: results.map((entry) => object(entry)),
    ...(error === undefined ? {} : { error }),
  });
}

/** Previews are read-only. Execution shares the lock used by run and resume. */
export async function collectExperimentCleanup(
  manager: Manager,
  { experimentId, dryRun, results }: ExperimentCleanupReport,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const experiment = await manager.get(safeId(experimentId));
  if (experiment.id !== experimentId)
    throw new Error('Experiment identity mismatch');
  signal.throwIfAborted();
  const ownership = new AbortController();
  let release: (() => Promise<void>) | undefined;
  try {
    if (!dryRun) {
      const gate = await acquireResourceGate(manager.directory);
      try {
        release = await acquireExecutionLock(
          manager.directory,
          experimentId,
          gate,
          ownership,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ELOCKED'
        )
          throw new ExperimentInUseError(
            `Experiment ${experimentId} is in use. Preview with --dry-run or retry after it finishes.`,
          );
        throw error;
      } finally {
        await gate.release();
      }
    }
    const cleanupSignal = AbortSignal.any([signal, ownership.signal]);
    cleanupSignal.throwIfAborted();
    await collectBindingCleanup(
      manager.options.registry,
      {
        experimentId,
        dryRun,
        dataDirectory: manager.directory,
        facts: cleanupFacts(manager.facts, ownership.signal, dryRun),
        signal: cleanupSignal,
      },
      results,
    );
    ownership.signal.throwIfAborted();
  } finally {
    await release?.();
  }
}
