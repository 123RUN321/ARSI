import type {
  CleanupContext,
  CleanupResult,
  FactStore,
  JsonSchema,
} from '../../contracts/index.js';
import { errorText } from '../../shared/errors.js';
import { validate } from '../../shared/schema.js';
import type { Registry } from '../registry/index.js';
import type { UsedBinding } from './binding-history.js';
import { json, object } from '../../shared/json.js';

export type BindingCleanupResult = CleanupResult & UsedBinding;
type ExperimentCleanupContext = Omit<CleanupContext, keyof UsedBinding>;

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

/** Each owner answers independently. Keep results collected before interruption. */
export async function collectBindingCleanup(
  registry: Registry,
  context: ExperimentCleanupContext,
  bindings: readonly UsedBinding[],
  results: BindingCleanupResult[],
): Promise<void> {
  for (const owner of bindings) {
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

export async function resourceCleanupComplete(
  facts: FactStore,
  id: string,
): Promise<boolean> {
  try {
    const report = await facts.read('resource-cleanup', id);
    return report.experimentId === id && report.status === 'complete';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

/** Resource results remain retryable independently of the saved business and instance disposal outcomes. */
export async function cleanAfterSuccess(
  registry: Registry,
  context: ExperimentCleanupContext,
  bindings: readonly UsedBinding[],
): Promise<void> {
  const results: BindingCleanupResult[] = [];
  let error: string | undefined;
  try {
    await collectBindingCleanup(registry, context, bindings, results);
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
