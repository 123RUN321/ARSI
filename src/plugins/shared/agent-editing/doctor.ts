import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DoctorContext, DoctorRule } from '../../../contracts/index.js';
import { missingInputError } from '../../../shared/doctor-check.js';
import { parseConfig } from '../../../shared/schema.js';
import { missingPath } from '../doctor/checks.js';
import { loadAgentPrompt } from './index.js';
import { prepareAgentProject, type AgentRole } from './project.js';
import type { AgentEditingConfig } from './schema.js';

type CheckedRole = { role: AgentRole; promptField: string };

export function checkAgentEditor<C extends AgentEditingConfig>(
  context: DoctorContext,
  checkedRoles: (config: C) => readonly CheckedRole[] = () => [],
): DoctorRule[] {
  context.signal.throwIfAborted();
  const config = parseConfig<C>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const skills = config.skills ?? [];
  const roles = checkedRoles(config);
  let prompt: string;
  async function areEditingInputsReadable(
    signal: AbortSignal,
  ): Promise<boolean> {
    prompt = await readEditingInputs(config, roles, signal);
    return true;
  }
  async function isProjectPrepared(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    await prepareAgentProject(
      context.runtime.extend({ signal }),
      prompt,
      {},
      skills,
      roles.map(({ role }) => role),
    );
    signal.throwIfAborted();
    return true;
  }
  return [
    {
      id: 'editing-inputs',
      check: areEditingInputsReadable,
      reason:
        'Restore the configured prompt, guidance, skills and role prompt files.',
    },
    {
      id: 'prepare-project',
      check: isProjectPrepared,
      reason:
        'Correct the editing project configuration, including unique roles and skill names.',
    },
  ];
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
