import type { FactStore, JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { errorText } from '../../shared/errors.js';

export type UsedBinding = { bindingId: string; pluginId: string };

function binding(record: JsonObject): UsedBinding {
  return {
    bindingId: string(record.bindingId, 'used binding ID'),
    pluginId: string(record.pluginId, 'used plugin ID'),
  };
}

function includes(entries: UsedBinding[], owner: UsedBinding): boolean {
  return entries.some(
    (entry) =>
      entry.bindingId === owner.bindingId && entry.pluginId === owner.pluginId,
  );
}

/** Older workspaces recorded ownership on current and superseded call receipts. */
export function legacyBindingReader(
  facts: FactStore,
  ids: ReadonlySet<string>,
): (id: string) => Promise<UsedBinding[]> {
  async function index(): Promise<Map<string, UsedBinding[] | Error>> {
    const byExperiment = new Map<string, UsedBinding[] | Error>();
    for (const kind of ['calls', 'call-attempts']) {
      for await (const call of facts.scan?.(kind) ?? (await facts.list(kind))) {
        if (
          typeof call.experimentId !== 'string' ||
          !ids.has(call.experimentId)
        )
          continue;
        const used = byExperiment.get(call.experimentId) ?? [];
        if (used instanceof Error) continue;
        try {
          const owner = binding({
            bindingId: call.bindingId,
            pluginId: call.pluginId ?? call.bindingRef,
          });
          if (!includes(used, owner)) used.push(owner);
          byExperiment.set(call.experimentId, used);
        } catch (error) {
          byExperiment.set(
            call.experimentId,
            new Error('Invalid call binding: ' + errorText(error)),
          );
        }
      }
    }
    return byExperiment;
  }
  let history: ReturnType<typeof index> | undefined;
  return async (id) => {
    const used = (await (history ??= index())).get(id);
    if (used instanceof Error) throw used;
    return used ?? [];
  };
}

export async function readUsedBindings(
  facts: FactStore,
  id: string,
  legacy = legacyBindingReader(facts, new Set([id])),
): Promise<UsedBinding[]> {
  let record: JsonObject;
  try {
    record = await facts.read('used-bindings', id);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return legacy(id);
    throw error;
  }
  if (record.experimentId !== id || !Array.isArray(record.bindings))
    throw new Error('Invalid binding history for experiment ' + id);
  return record.bindings.map((entry) => binding(object(entry)));
}

/** A single execution owns this history. Concurrent factories must all be recorded before acquisition. */
export class BindingHistory {
  private writing = Promise.resolve();
  constructor(
    private readonly facts: FactStore,
    private readonly id: string,
    readonly entries: UsedBinding[],
  ) {}
  record(bindingId: string, pluginId: string): Promise<void> {
    const owner = { bindingId, pluginId };
    const job = this.writing.then(async () => {
      if (includes(this.entries, owner)) return;
      const bindings = [...this.entries, owner];
      await this.facts.write('used-bindings', this.id, {
        experimentId: this.id,
        bindings,
      });
      this.entries.push(owner);
    });
    this.writing = job.catch(() => {});
    return job;
  }
}
