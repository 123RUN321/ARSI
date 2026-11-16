import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { roleNamePattern } from '../shared/agent-editing/project.js';

export async function readProjectRole(
  cwd: string,
  role: string,
): Promise<{ path: string; content: string }> {
  if (!new RegExp(roleNamePattern).test(role))
    throw new Error('Invalid agent role');
  const path = join(cwd, 'roles', `${role}.md`);
  if (!(await lstat(path)).isFile())
    throw new Error(`Invalid agent role file: ${role}`);
  return { path, content: await readFile(path, 'utf8') };
}

/** Native Pi delegation stays inside the SDK call and its shared model budget. */
export async function createProjectSubagentTool(
  cwd: string,
  invoke: (role: string, task: string) => Promise<JsonObject>,
): Promise<ToolDefinition | undefined> {
  const entries = await readdir(join(cwd, 'roles'), { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -3));
  if (!names.length) return undefined;
  const parameters = {
    type: 'object',
    properties: {
      agent: { enum: names },
      task: { type: 'string', minLength: 1 },
    },
    required: ['agent', 'task'],
    additionalProperties: false,
  };
  return {
    name: 'subagent',
    label: 'Run a specialist',
    description: 'Run a configured specialist inside this task.',
    parameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      validate(parameters, input, 'subagent input');
      const task = object(input);
      const result = await invoke(string(task.agent), string(task.task));
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: {},
      };
    },
  };
}
