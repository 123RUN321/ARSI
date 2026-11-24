import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DoctorContext,
  DoctorResult,
  JsonValue,
  OperationDoctor,
} from '../../contracts/index.js';
import { missingInputReason } from '../../shared/doctor-check.js';
import { missingPath } from '../shared/doctor/checks.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import type { SdkEvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';
import { checkSdkDoctor } from '../shared/evaluator-adapter/doctor.js';
import type { SdkDoctorRunner } from '../shared/evaluator-adapter/doctor-sdk.js';
import { prepareEvaluationConfig } from './service.js';

function taskIds(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(taskIds);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, entry]) =>
      /taskIds$/i.test(key) && Array.isArray(entry)
        ? entry.filter((item): item is string => typeof item === 'string')
        : taskIds(entry),
    );
  return [];
}

async function bundleDirectory(
  ctx: DoctorContext,
  checks: DoctorResult['checks'],
): Promise<string> {
  const baseline = plain(ctx.recipe.application.config.baseline);
  if (typeof baseline.directory === 'string') return baseline.directory;
  if (typeof baseline.artifactRef === 'string') {
    const directory = join(ctx.directory, 'baseline');
    await ctx.runtime.artifacts.materialize(baseline.artifactRef, directory);
    return directory;
  }
  checks.push({
    id: 'application-instance',
    status: 'unchecked',
    reason:
      'The Application supplies its instance during execution; SDK doctor uses a temporary path without establishing instance readiness.',
  });
  return ctx.directory;
}

async function prepareConfig(
  ctx: DoctorContext,
  checks: DoctorResult['checks'],
): Promise<SdkEvaluatorConfig> {
  if (
    ['application.inference', 'application.kernel'].includes(
      ctx.recipe.application.pluginId,
    )
  )
    throw new Error(
      'evaluator.agentbench requires an Application with the agentbundle capability.',
    );
  return prepareEvaluationConfig(ctx.binding.config, {
    taskIds: [...new Set(taskIds(ctx.recipe.policyConfig))],
    execution: { directory: await bundleDirectory(ctx, checks) },
    directory: ctx.directory,
  });
}

export function createAgentbenchDoctor(run?: SdkDoctorRunner): OperationDoctor {
  return async (ctx) => {
    const checks: DoctorResult['checks'] = [];
    const sdk = await checkSdkDoctor(
      ctx,
      (ctx) => prepareConfig(ctx, checks),
      run,
    );
    const { directory } = plain(ctx.recipe.application.config.baseline);
    const bundleCheck = sdk.checks.find(
      (check) =>
        check.status === 'failed' &&
        check.details?.sdkName === 'AgentBundle path',
    );
    if (bundleCheck && typeof directory === 'string') {
      // Confirm absence without interpreting the SDK's human-readable detail.
      await access(directory).catch((error: unknown) => {
        if (missingPath(error)) {
          bundleCheck.reason = [
            bundleCheck.reason,
            missingInputReason(
              'application.config.baseline.directory',
              'directory',
              directory,
            ),
          ]
            .filter(Boolean)
            .join(' ');
        }
      });
    }
    checks.push(...sdk.checks);
    if (sdk.reported)
      checks.push(
        {
          id: 'model-access',
          status: 'unchecked',
          reason:
            'The installed Evaluator SDK doctor does not query model lists, so evaluation model availability is unchecked.',
        },
        {
          id: 'docker-disk-capacity',
          status: 'unchecked',
          reason:
            'The installed Evaluator SDK doctor does not measure disk capacity, so evaluation storage sufficiency is unchecked.',
        },
      );
    return { checks };
  };
}

export const agentbenchDoctor = createAgentbenchDoctor();
