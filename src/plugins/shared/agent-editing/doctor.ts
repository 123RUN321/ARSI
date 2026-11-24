import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import {
  missingInputError,
  runDoctorCheck,
  runDoctorProbe,
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
  const options = { signal: context.signal };
  const inputs = await runDoctorProbe(
    'editing-inputs',
    (signal) => readEditingInputs(config, roles, signal),
    options,
  );
  const prompt = inputs.value;
  if (prompt === undefined) {
    return {
      checks: [
        inputs.check,
        {
          id: 'prepare-project',
          status: 'unchecked',
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
  return { checks: [inputs.check, prepared] };
}

async function readEditingInputs(
  config: AgentEditingConfig,
  roles: readonly CheckedRole[],
  signal: AbortSignal,
): Promise<string> {
  const skills = config.skills ?? [];
  try {
    signal.throwIfAborted();
    const prompt = await loadAgentPrompt(config);
    for (const directory of skills)
      await readFile(join(directory, 'SKILL.md'), { signal });
    for (const { role } of roles) await readFile(role.prompt, { signal });
    return prompt;
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
      throw missingInputError(
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
}
