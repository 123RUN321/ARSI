import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { visitConfigStrings } from '../../shared/config-fields.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';

export async function* checkDeclaredBindings({
  binding,
  recipe,
  signal,
}: DoctorContext): AsyncGenerator<DoctorResult['checks'][number]> {
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
    yield runDoctorCheck(
      `binding.${field}`,
      async () => {
        const [contract] = contracts;
        if (contracts.size > 1)
          throw new Error(
            `${configField} has conflicting binding contracts (${[...contracts].join(', ')}). Correct the plugin Schema to declare one contract for this field.`,
          );
        if (!Object.hasOwn(recipe.bindings, reference))
          throw new Error(
            `${configField} refers to ${reference}, which is not declared. Use a declared binding implementing ${contract}.`,
          );
        const target = recipe.bindings[reference]!;
        const actual = target.definition.contract.id;
        if (actual !== contract)
          throw new Error(
            `${configField} refers to ${reference}, which implements ${actual} through ${target.pluginId}. Use a binding implementing ${contract}.`,
          );
      },
      { signal },
    );
  }
}
