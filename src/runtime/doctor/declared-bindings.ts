import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { visitConfigStrings } from '../../shared/config-fields.js';
import { failed, passed } from '../../shared/doctor-check.js';

export function* checkDeclaredBindings({
  binding,
  recipe,
  signal,
}: DoctorContext): Generator<DoctorResult['checks'][number]> {
  signal.throwIfAborted();
  const references = new Map<
    string,
    { reference: string; contracts: Set<string> }
  >();
  visitConfigStrings(
    binding.definition.configSchema,
    binding.config,
    (pointer, reference, schema) => {
      const contract = schema['x-rsi-binding'];
      if (typeof contract !== 'string') return;
      const previous = references.get(pointer);
      if (previous) previous.contracts.add(contract);
      else
        references.set(pointer, { reference, contracts: new Set([contract]) });
    },
  );
  for (const [pointer, { reference, contracts }] of references) {
    const field = pointer.slice(1).replaceAll('/', '.');
    const configField = `${binding.name}.config.${field}`;
    signal.throwIfAborted();
    const id = `binding.${field}`;
    const [contract] = contracts;
    if (contracts.size > 1) {
      yield* failed(
        id,
        `${configField} has conflicting binding contracts (${[...contracts].join(', ')}). Correct the plugin Schema to declare one contract for this field.`,
      ).checks;
      return;
    }
    if (!Object.hasOwn(recipe.bindings, reference)) {
      yield* failed(
        id,
        `${configField} refers to ${reference}, which is not declared. Use a declared binding implementing ${contract}.`,
      ).checks;
      return;
    }
    const target = recipe.bindings[reference]!;
    const actual = target.definition.contract.id;
    if (actual !== contract) {
      yield* failed(
        id,
        `${configField} refers to ${reference}, which implements ${actual} through ${target.pluginId}. Use a binding implementing ${contract}.`,
      ).checks;
      return;
    }
    yield* passed(id).checks;
  }
}
