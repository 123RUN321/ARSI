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
    yield runDoctorCheck(
      `binding.${field}`,
      async () => {
        const [contract] = contracts;
        if (contracts.size > 1)
          throw new Error(
            `${field}: conflicting binding contracts (${[...contracts].join(', ')})`,
          );
        if (!Object.hasOwn(recipe.bindings, reference))
          throw new Error(`${field}: binding ${reference} is not declared`);
        const target = recipe.bindings[reference]!;
        const actual = target.definition.contract.id;
        if (actual !== contract)
          throw new Error(
            `${field}: binding ${reference} must implement ${contract}, but ${target.pluginId} implements ${actual}`,
          );
      },
      { signal },
    );
  }
}
