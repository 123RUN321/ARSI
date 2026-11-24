import { resolve } from 'node:path';
import type {
  DoctorBinding,
  DoctorContext,
  DoctorRegistry,
  DoctorReport,
  DoctorResult,
} from '../../contracts/index.js';
import {
  errorText,
  RuntimeCleanupInterruptedError,
} from '../../shared/errors.js';
import type { Runtime } from '../context.js';
import { Recipe } from '../loaders/recipe.js';
import { withBindingInstance } from '../manager/instances.js';
import type { Registry } from '../registry/index.js';
import { openProbeRuntime } from './probe-runtime.js';
import {
  bindingReferenceRules,
  declaredPathRules,
  runDoctorRules,
} from './rules.js';
import { createFailureReport, DoctorReportBuilder } from './report.js';

/** The caller owns the Runtime if diagnosis throws before releasing it. */
export async function runDoctor(
  recipePath: string,
  {
    signal,
    openRuntime,
    releaseRuntime,
  }: {
    signal: AbortSignal;
    openRuntime(): Promise<Runtime>;
    releaseRuntime(): Promise<void>;
  },
): Promise<DoctorReport> {
  let runtime: Runtime;
  try {
    runtime = await openRuntime();
  } catch (error) {
    signal.throwIfAborted();
    return createFailureReport('runtime.registration', error);
  }

  const report = await doctorRecipe(runtime, recipePath, { signal }).catch(
    (error: unknown) => {
      signal.throwIfAborted();
      return createFailureReport('doctor.runtime', error);
    },
  );
  try {
    await releaseRuntime();
  } catch (error) {
    if (signal.aborted)
      throw new RuntimeCleanupInterruptedError(signal.reason, error);
    const cleanupReport = createFailureReport('runtime.cleanup', error);
    report.checks.push(...cleanupReport.checks);
  }
  signal.throwIfAborted();
  return report;
}

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
  const prerequisites = await runDoctorRules(
    [...declaredPathRules(binding), ...bindingReferenceRules(context)],
    signal,
  );
  reportBuilder.addBindingResult(binding, prerequisites);
  if (prerequisites.checks.some((check) => check.status === 'failed')) {
    reportBuilder.addBindingCheck(binding, {
      id: 'plugin',
      status: 'unchecked',
      reason:
        'Plugin diagnostics were not executed because a declared prerequisite failed. Fix it and rerun doctor.',
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
