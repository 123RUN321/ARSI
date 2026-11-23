import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import {
  DoctorMissingResourceError,
  runDoctorCheck,
} from '../../../shared/doctor-check.js';
import { parseConfig } from '../../../shared/schema.js';
import { missingPath } from '../doctor/checks.js';
import { loadAgentPrompt } from './index.js';
import { prepareAgentProject, type AgentRole } from './project.js';
import type { AgentEditingConfig } from './schema.js';

type CheckedRole = { role: AgentRole; promptField: string };

export async function checkAgentEditor<C extends AgentEditingConfig>(
  context: DoctorContext,
  checkedRoles: (config: C) => readonly CheckedRole[] = () => [],
): Promise<DoctorResult> {
  context.signal.throwIfAborted();
  const config = parseConfig<C>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const skills = config.skills ?? [];
  const roles = checkedRoles(config);
  const inputPathChecks = [
    'resource.prompt',
    'resource.guidance',
    ...skills.map((_, index) => `resource.skills.${index}`),
    ...roles.map(({ promptField }) => `resource.${promptField}`),
  ];
  const blockedBy = context.failedPrerequisites?.find((id) =>
    inputPathChecks.includes(id),
  );
  if (blockedBy)
    return {
      checks: ['editing-inputs', 'prepare-project'].map((id) => ({
        id,
        status: 'unchecked',
        blockedBy,
      })),
    };

  const options = { signal: context.signal };
  let prompt = '';
  const loaded = await runDoctorCheck(
    'editing-inputs',
    async (signal) => {
      try {
        signal.throwIfAborted();
        prompt = await loadAgentPrompt(config);
        for (const directory of skills)
          await readFile(join(directory, 'SKILL.md'), { signal });
        for (const { role } of roles) await readFile(role.prompt, { signal });
      } catch (error) {
        const path = missingPath(error);
        if (path) {
          const skillIndex = skills.findIndex(
            (directory) =>
              path === directory || path === join(directory, 'SKILL.md'),
          );
          const checkedRole = roles.find(({ role }) => role.prompt === path);
          const field =
            path === config.prompt
              ? 'prompt'
              : skillIndex >= 0
                ? `skills.${skillIndex}`
                : (checkedRole?.promptField ?? 'guidance');
          throw new DoctorMissingResourceError(
            {
              field,
              kind: path === config.guidance ? 'directory' : 'file',
              reference: path,
            },
            error,
          );
        }
        throw error;
      }
    },
    options,
  );
  if (loaded.status !== 'passed') {
    return {
      checks: [
        loaded,
        {
          id: 'prepare-project',
          status: 'unchecked',
          blockedBy: loaded.id,
          reason:
            'Editing inputs could not be loaded; project preparation did not run.',
        },
      ],
    };
  }
  const prepared = await runDoctorCheck(
    'prepare-project',
    async (signal) => {
      signal.throwIfAborted();
      await prepareAgentProject(
        context.runtime.extend({ signal }),
        prompt,
        {},
        skills,
        roles.map(({ role }) => role),
      );
      signal.throwIfAborted();
    },
    options,
  );
  return { checks: [loaded, prepared] };
}
