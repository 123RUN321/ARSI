import { resolve } from 'node:path';
import type {
  DoctorBinding,
  DoctorContext,
  DoctorRegistry,
  DoctorReport,
} from '../../contracts/index.js';
import { errorText } from '../../shared/errors.js';
import type { Runtime } from '../context.js';
import { Recipe } from '../loaders/recipe.js';
import type { Registry } from '../registry/index.js';
import { diagnoseBinding } from './dispatch.js';
import { checkDeclaredPaths } from './declared-paths.js';
import { openDoctorProbeRuntime } from './probe-runtime.js';
import { doctorFailure, DoctorReportBuilder } from './report.js';

export { diagnoseBinding };

/** Internal runner: never runs a Policy or writes to the invoking experiment store. */
export async function doctorRecipe(
  runtime: Runtime,
  path: string,
  { signal = new AbortController().signal }: { signal?: AbortSignal } = {},
): Promise<DoctorReport> {
  signal.throwIfAborted();
  let recipe: Recipe;
  try {
    recipe = await Recipe.load(resolve(path), runtime.registry);
  } catch (error) {
    signal.throwIfAborted();
    return doctorFailure('recipe.validate', error);
  }

  const report = new DoctorReportBuilder(recipe.id, {
    recipe: recipe.toJSON(),
    reflection: recipe.reflection?.implementation.config ?? {},
  });
  report.add({ id: 'recipe.validate', status: 'passed' });
  const bindings = diagnosticBindings(recipe, runtime.registry);
  const probes = await openDoctorProbeRuntime(runtime, signal);
  try {
    for (const [index, binding] of bindings.entries()) {
      signal.throwIfAborted();
      const scope = await probes.createBindingContext(index, binding.name);
      await checkBinding(
        {
          binding,
          recipe,
          registry: runtime.registry,
          runtime: scope,
          directory: scope.directory,
          signal,
        },
        report,
      );
    }
  } finally {
    for (const { id, error } of await probes.dispose())
      report.add({ id, status: 'failed', reason: errorText(error) });
  }

  signal.throwIfAborted();
  return report.build();
}

function diagnosticBindings(
  recipe: Recipe,
  registry: DoctorRegistry,
): DoctorBinding[] {
  const bindings = [recipe.application, ...Object.values(recipe.bindings)];
  if (!recipe.reflection) return bindings;

  const { ref, config } = recipe.reflection.implementation;
  return [
    ...bindings,
    {
      name: 'reflection',
      pluginId: ref,
      definition: registry.get(ref),
      config,
    },
  ];
}

async function checkBinding(
  context: DoctorContext & { registry: Registry },
  report: DoctorReportBuilder,
): Promise<void> {
  const { binding, signal } = context;
  let pathBlocker: string | undefined;
  for await (const check of checkDeclaredPaths(binding, signal)) {
    report.addBindingCheck(binding, check);
    if (check.status === 'failed') pathBlocker ??= check.id;
  }
  if (pathBlocker) {
    report.addBindingCheck(binding, {
      id: 'plugin',
      status: 'unchecked',
      blockedBy: pathBlocker,
    });
    return;
  }

  try {
    const result = await diagnoseBinding(context.registry, context);
    signal.throwIfAborted();
    report.addPluginResult(binding, result);
  } catch (error) {
    signal.throwIfAborted();
    report.addBindingCheck(binding, {
      id: 'script',
      status: 'failed',
      reason: `${errorText(error)} Plugin availability is unknown.`,
    });
  }
}
