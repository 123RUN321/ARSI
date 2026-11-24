import type { DoctorContext, DoctorStep } from '../../contracts/index.js';
import { visitConfigStrings } from '../../shared/config-fields.js';

export function bindingReferenceSteps({
  binding,
  recipe,
  signal,
}: DoctorContext): DoctorStep[] {
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
  return [...references].map(([pointer, { reference, contracts }]) => {
    const field = pointer.slice(1).replaceAll('/', '.');
    const configField = `${binding.name}.config.${field}`;
    return {
      id: `binding.${field}`,
      reason: `Correct ${configField} to reference a binding implementing its declared contract.`,
      check: () => {
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
        return true;
      },
    };
  });
}
