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
import { checkDeclaredBindings } from './declared-bindings.js';
import { diagnoseBinding } from './dispatch.js';
import { checkDeclaredPaths } from './declared-paths.js';
import { openProbeRuntime } from './probe-runtime.js';
import { createFailureReport, DoctorReportBuilder } from './report.js';

export { diagnoseBinding };

/** Internal runner: never runs a Policy or writes to the invoking experiment store. */
export async function doctorRecipe(
  sourceRuntime: Runtime,
  recipePath: string,
  { signal = new AbortController().signal }: { signal?: AbortSignal } = {},
): Promise<DoctorReport> {
  signal.throwIfAborted();
  let recipe: Recipe;
  try {
    recipe = await Recipe.load(resolve(recipePath), sourceRuntime.registry);
  } catch (error) {
    signal.throwIfAborted();
    return createFailureReport('recipe.validate', error);
  }

  const reportBuilder = new DoctorReportBuilder(recipe.id, {
    recipe: recipe.toJSON(),
    reflection: recipe.reflection?.implementation.config ?? {},
  });
  reportBuilder.addCheck({ id: 'recipe.validate', status: 'passed' });
  await checkBindings(sourceRuntime, recipe, reportBuilder, signal);
  signal.throwIfAborted();
  return reportBuilder.build();
}

/** Owns the probe Runtime for the binding phase. */
async function checkBindings(
  sourceRuntime: Runtime,
  recipe: Recipe,
  reportBuilder: DoctorReportBuilder,
  signal: AbortSignal,
): Promise<void> {
  const bindings = getDoctorBindings(recipe, sourceRuntime.registry);
  const probeRuntime = await openProbeRuntime(sourceRuntime, signal);
  try {
    for (const [bindingIndex, binding] of bindings.entries()) {
      signal.throwIfAborted();
      const bindingContext = await probeRuntime.createBindingContext(
        bindingIndex,
        binding.name,
      );
      await checkBinding(
        {
          binding,
          recipe,
          registry: sourceRuntime.registry,
          runtime: bindingContext,
          directory: bindingContext.directory,
          signal,
        },
        reportBuilder,
      );
    }
  } finally {
    for (const { id, error } of await probeRuntime.dispose())
      reportBuilder.addCheck({
        id,
        status: 'failed',
        reason: errorText(error),
      });
  }
}

function getDoctorBindings(
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
  reportBuilder: DoctorReportBuilder,
): Promise<void> {
  const { binding, signal } = context;
  const failedPaths: string[] = [];
  for await (const check of checkDeclaredPaths(binding, signal)) {
    reportBuilder.addBindingCheck(binding, check);
    if (check.status === 'failed')
      failedPaths.push(`${binding.name}.${check.id}`);
  }
  for await (const check of checkDeclaredBindings(context))
    reportBuilder.addBindingCheck(binding, check);
  if (failedPaths.length) {
    reportBuilder.addBindingCheck(binding, {
      id: 'plugin',
      status: 'unchecked',
      reason: `Plugin checks did not run because these path checks failed: ${failedPaths.join(', ')}.`,
    });
    return;
  }

  try {
    const bindingResult = await diagnoseBinding(context.registry, context);
    signal.throwIfAborted();
    reportBuilder.addBindingResult(binding, bindingResult);
  } catch (error) {
    signal.throwIfAborted();
    reportBuilder.addBindingCheck(binding, {
      id: 'script',
      status: 'failed',
      reason: `${errorText(error)} Plugin availability is unknown.`,
    });
  }
}
