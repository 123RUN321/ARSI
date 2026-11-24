import type { Context } from '@deepseek-ai/cordis';
import type {
  Binding,
  Operation,
  RuntimeContext,
  EventPipeline,
  OperationEventMap,
} from '../../contracts/index.js';
import type { Registry } from '../registry/index.js';
import { type EventScope, ManagedEvents } from '../services/events.js';

// Cordis supplies the explicit dispatch target to this hook before invoking listeners.
function restrictBindingRequests(
  events: ManagedEvents,
  target?: EventScope,
): void {
  events.context.on('internal/dispatch', (_mode, name, _args, caller) => {
    if (
      (name === 'rsi/doctor' || name === 'rsi/cleanup') &&
      (!target || caller !== target.context)
    )
      throw new Error(`${name} requires an explicit request to a binding`);
  });
}

interface Instance {
  operation: Operation;
  scope: EventScope;
  uses: Set<Promise<unknown>>;
  disposal?: Promise<void>;
  disposalState?: 'pending' | 'succeeded' | 'failed';
}
interface Entry {
  ready: Promise<Instance>;
  uses: Set<Promise<unknown>>;
}

/** Manager retains each instance until both calls and admitted listeners release it. */
export class Instances {
  private readonly current = new Map<string, Entry>();
  private readonly owned = new Set<Instance>();
  private readonly preparing = new Set<Promise<Instance>>();
  constructor(
    private readonly registry: Registry,
    private readonly events: ManagedEvents,
    private readonly context: (bindingId: string) => RuntimeContext,
  ) {
    restrictBindingRequests(events);
  }

  prepare(
    bindingId: string,
    binding: Binding,
    uses = new Set<Promise<unknown>>(),
  ): Promise<Instance> {
    const job = this.create(bindingId, binding, uses);
    this.preparing.add(job);
    void job.finally(() => this.preparing.delete(job)).catch(() => {});
    return job;
  }

  private async create(
    bindingId: string,
    binding: Binding,
    uses: Set<Promise<unknown>>,
  ): Promise<Instance> {
    const scope = this.events.prepare(bindingId);
    try {
      const operation = await this.registry.createManagedOperation(
        binding.plugin,
        binding.config,
        this.context(bindingId).extend({ event: scope.event }),
      );
      const instance: Instance = { operation, scope, uses };
      this.owned.add(instance);
      return instance;
    } catch (error) {
      this.events.deactivate(scope);
      this.events.release(scope);
      throw error;
    }
  }

  activate(
    bindingId: string,
    instance: Instance,
  ): Promise<Instance> | undefined {
    const previous = this.current.get(bindingId);
    this.events.activate(instance.scope);
    this.current.set(bindingId, {
      ready: Promise.resolve(instance),
      uses: instance.uses,
    });
    return previous?.ready;
  }

  async acquire(
    bindingId: string,
    binding: Binding,
  ): Promise<{ operation: Operation; event: EventPipeline; release(): void }> {
    let entry = this.current.get(bindingId);
    if (!entry) {
      const uses = new Set<Promise<unknown>>();
      const prepared = this.prepare(bindingId, binding, uses);
      const created: Entry = {
        ready: prepared.then((instance) => {
          if (this.current.get(bindingId) === created)
            this.events.activate(instance.scope);
          return instance;
        }),
        uses,
      };
      entry = created;
      this.current.set(bindingId, entry);
    }
    let release!: () => void;
    const use = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Reserve before awaiting creation so a concurrent replacement cannot retire it.
    entry.uses.add(use);
    let instance: Instance;
    try {
      instance = await entry.ready;
    } catch (error) {
      entry.uses.delete(use);
      release();
      throw error;
    }
    return {
      operation: instance.operation,
      event: instance.scope.event,
      release: () => {
        instance.uses.delete(use);
        release();
      },
    };
  }

  dispose(instance: Instance): Promise<void> {
    if (instance.disposal) return instance.disposal;
    this.events.deactivate(instance.scope);
    instance.disposalState = 'pending';
    instance.disposal = (async () => {
      await this.events.idle(instance.scope);
      while (instance.uses.size) await Promise.allSettled([...instance.uses]);
      await instance.operation.dispose();
      this.events.release(instance.scope);
      this.owned.delete(instance);
    })().then(
      () => {
        instance.disposalState = 'succeeded';
      },
      (error: unknown) => {
        instance.disposalState = 'failed';
        throw new Error(`Instance ${instance.scope.bindingId} cleanup failed`, {
          cause: error,
        });
      },
    );
    return instance.disposal;
  }

  /** Caller has reconciled external effects; pending disposal can never be acknowledged. */
  reconcileFailures(): void {
    if (
      this.preparing.size ||
      [...this.owned].some((instance) => instance.disposalState !== 'failed')
    )
      throw new Error('Instance cleanup is still pending');
    for (const instance of this.owned) {
      this.events.release(instance.scope);
      this.owned.delete(instance);
    }
    this.current.clear();
  }

  async disposeAll(): Promise<void> {
    while (this.preparing.size) await Promise.allSettled([...this.preparing]);
    await Promise.allSettled(
      [...this.current.values()].map((entry) => entry.ready),
    );
    const results = await Promise.allSettled(
      [...this.owned].map((instance) => this.dispose(instance)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (!this.owned.size) this.current.clear();
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Instance cleanup failed',
      );
  }
}

// Standalone calls and CLI commands both own an instance outside an experiment.
export async function createIsolatedInstance(
  context: RuntimeContext,
  create: (runtime: RuntimeContext) => Promise<Operation>,
): Promise<{
  scope: EventScope;
  runtime: RuntimeContext;
  operation: Operation;
}> {
  const events = new ManagedEvents({
    context: (_bindingId, callId, signal) =>
      context.extend({
        callId,
        signal: context.signal
          ? AbortSignal.any([context.signal, signal])
          : signal,
      }),
    diagnostic: () => {},
  });
  const scope = events.prepare(context.bindingId);
  restrictBindingRequests(events, scope);
  const runtime = context.extend({ event: scope.event });
  await using lifetime = new AsyncDisposableStack();
  lifetime.defer(() => events.dispose());
  const operation = await create(runtime);
  lifetime.defer(() => operation.dispose());
  lifetime.defer(() => {
    events.deactivate(scope);
    events.abort(scope);
    return events.idle(scope);
  });
  events.activate(scope);
  const owned = lifetime.move();
  return {
    scope,
    runtime,
    operation: {
      execute: (input, ctx) =>
        operation.execute(
          input,
          ctx.event ? ctx : ctx.extend({ event: scope.event }),
        ),
      dispose: () => owned.disposeAsync(),
    },
  };
}

/** Address a command to a fresh instance, including bindings skipped during resume. */
export async function withBindingInstance<
  Name extends keyof OperationEventMap,
  Result,
>(
  registry: Registry,
  binding: Binding,
  context: RuntimeContext,
  name: Name,
  request: (
    target: Context,
    event: Name,
    runtime: RuntimeContext,
  ) => Promise<Result>,
): Promise<Result | undefined> {
  context.signal.throwIfAborted();
  await using lifetime = new AsyncDisposableStack();
  lifetime.defer(registry.retain(binding.plugin));
  const { scope, runtime, operation } = await createIsolatedInstance(
    context,
    async (ctx) => {
      try {
        return await registry.createManagedOperation(
          binding.plugin,
          binding.config,
          ctx,
        );
      } catch (cause) {
        throw new Error(
          `Failed to initialize ${binding.plugin} for binding ${context.bindingId}`,
          { cause },
        );
      }
    },
  );
  lifetime.defer(operation.dispose);
  context.signal.throwIfAborted();
  const handlers = [...scope.subscriptions].filter(
    (entry) => entry.name === name,
  );
  if (!handlers.length) return undefined;
  if (handlers.length > 1)
    throw new Error(
      `Expected one handler for ${name} on binding ${context.bindingId}`,
    );
  const result = await request(scope.context, name, runtime);
  if (result == null) throw new Error(`Plugin returned no result for ${name}`);
  return result;
}
