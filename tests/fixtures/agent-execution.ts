import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AgentInput,
  AgentLineHandler,
  AgentProcessSpec,
  RuntimeContext,
} from '../../src/contracts/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';

export const answerSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
export async function agentFixture(
  onLaunch?: (
    spec: AgentProcessSpec,
    onLine: AgentLineHandler,
    context: RuntimeContext,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-agent-execution-'));
  const registry = new Registry();
  const manager = new Manager({
    registry,
    rootDirectory: root,
    directory: join(root, 'data'),
  });
  const owner = manager.context.extend({
    callId: 'owner',
    directory: join(root, 'owner'),
    signal: new AbortController().signal,
  });
  const projectRef = await prepareAgentProject(
    owner,
    'Read context and edit candidate only when authorized.',
    { 'candidate/input.txt': 'original' },
    [],
    [],
  );
  const workspace = await manager.workspaces.read(projectRef);
  const directory = dirname(workspace.directory);
  const charges: { metric: string; amount: number }[] = [];
  const context = owner.extend({
    callId: 'agent',
    directory: join(root, 'agent-call'),
    agentProject: directory,
    async charge(metric: string, amount: number) {
      charges.push({ metric, amount });
    },
    ...(onLaunch
      ? {
          runAgentProcess: async function (
            this: RuntimeContext,
            spec: AgentProcessSpec,
            onLine: AgentLineHandler,
          ) {
            await onLaunch(spec, onLine, this);
          },
        }
      : {}),
  });
  await mkdir(context.directory, { recursive: true });
  const request: AgentInput = {
    projectRef,
    mode: 'edit',
    goal: 'Return an answer',
    outputSchema: answerSchema,
  };
  return {
    root,
    manager,
    owner,
    context,
    directory,
    request,
    charges,
    async close() {
      await manager.dispose();
      await registry.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
