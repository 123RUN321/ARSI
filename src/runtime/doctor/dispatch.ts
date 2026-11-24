import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { errorText } from '../../shared/errors.js';
import { withBindingInstance } from '../manager/instances.js';
import type { Registry } from '../registry/index.js';
import { runDoctorRules } from './rules.js';

export async function diagnoseBinding(
  registry: Registry,
  context: DoctorContext,
): Promise<DoctorResult> {
  const { binding, signal, directory } = context;
  try {
    const result = await withBindingInstance(
      registry,
      { plugin: binding.pluginId, config: binding.config },
      context.runtime.extend({ bindingId: binding.name, signal, directory }),
      'rsi/doctor',
      async (target, event, runtime) => {
        const rules = await target.serial(target, event, {
          ...context,
          runtime,
        });
        if (!rules) throw new Error('Doctor returned no check definitions.');
        return runDoctorRules(rules, signal);
      },
    );
    return (
      result ?? {
        checks: [
          {
            id: 'plugin',
            status: 'unchecked',
            reason: `Binding ${binding.name}, implementation ${binding.pluginId}, has no doctor capability.`,
          },
        ],
      }
    );
  } catch (error) {
    signal.throwIfAborted();
    return {
      checks: [{ id: 'script', status: 'failed', reason: errorText(error) }],
    };
  }
}
