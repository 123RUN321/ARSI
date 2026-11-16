import { randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ArtifactStore,
  WorkspaceService,
  Workspace,
  RuntimeContext,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { atomic, safeId } from './index.js';

export class FileWorkspaces implements WorkspaceService {
  constructor(
    readonly directory: string,
    private readonly artifacts: ArtifactStore,
  ) {}
  async create(
    artifactRef?: string,
    parentCandidateRef?: string,
    project?: { ownerCallId: string; inputRef: string },
  ): Promise<Workspace> {
    const ref = randomUUID();
    const directory = project
      ? join(this.directory, ref, 'project', 'candidate')
      : join(this.directory, ref, 'files');
    await mkdir(directory, { recursive: true });
    const workspace = {
      ref,
      directory,
      parentCandidateRef: parentCandidateRef ?? null,
      ...(project ? { project } : {}),
    };
    await atomic(join(this.directory, ref, 'workspace.json'), workspace);
    try {
      if (artifactRef) await this.artifacts.materialize(artifactRef, directory);
      return workspace;
    } catch (error) {
      await this.release(ref);
      throw error;
    }
  }
  async read(ref: string): Promise<Workspace> {
    const value = object(
      JSON.parse(
        await readFile(
          join(this.directory, safeId(ref), 'workspace.json'),
          'utf8',
        ),
      ),
    );
    const directory = string(value.directory);
    const project =
      value.project === undefined ? undefined : object(value.project);
    if (
      directory !==
      (project
        ? join(this.directory, ref, 'project', 'candidate')
        : join(this.directory, ref, 'files'))
    )
      throw new Error('Workspace identity mismatch');
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Workspace is not a real directory');
    let leaseOwner: string | undefined;
    try {
      leaseOwner = string(
        object(
          JSON.parse(
            await readFile(
              join(this.directory, ref, 'agent-lease.json'),
              'utf8',
            ),
          ),
        ).callId,
      );
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    return {
      ref,
      directory,
      ...(leaseOwner ? { leaseOwner } : {}),
      ...(project
        ? {
            project: {
              ownerCallId: string(project.ownerCallId),
              inputRef: string(project.inputRef),
            },
          }
        : {}),
      parentCandidateRef:
        typeof value.parentCandidateRef === 'string'
          ? value.parentCandidateRef
          : null,
    };
  }
  async release(ref: string): Promise<void> {
    try {
      await readFile(join(this.directory, safeId(ref), 'agent-lease.json'));
      throw new Error(
        'Cannot release a workspace with an active or unconfirmed Agent execution',
      );
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    await rm(join(this.directory, safeId(ref)), {
      recursive: true,
      force: true,
    });
  }
}

/** Project directory layout and publication belong to this storage module. */
export function agentProjectDirectory(workspace: Workspace): string {
  if (!workspace.project) throw new Error('Agent requires an owned project');
  return dirname(workspace.directory);
}

export async function createAgentProject(
  context: RuntimeContext,
  inputRef: string,
  parentCandidateRef?: string,
): Promise<string> {
  const workspace = await context.workspaces.create(
    undefined,
    parentCandidateRef,
    { ownerCallId: context.callId, inputRef },
  );
  try {
    await rm(workspace.directory, { recursive: true });
    const root = agentProjectDirectory(workspace);
    await context.artifacts.materialize(inputRef, root);
    await mkdir(workspace.directory, { recursive: true });
    for (const name of ['roles', 'scratch'])
      await mkdir(join(root, name), { recursive: true });
    return workspace.ref;
  } catch (error) {
    await context.workspaces.release(workspace.ref);
    throw error;
  }
}

export async function leaseAgentProject(
  context: RuntimeContext,
  ref: string,
  ownerCallId: string,
): Promise<{ inputRef: string; release(unknown: boolean): Promise<void> }> {
  const workspace = await context.workspaces.read(ref);
  if (workspace.project?.ownerCallId !== ownerCallId)
    throw new Error('Agent project must be owned by the calling operation');
  const file = join(
    dirname(agentProjectDirectory(workspace)),
    'agent-lease.json',
  );
  try {
    await writeFile(file, JSON.stringify({ callId: context.callId }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error('Agent project is already executing', { cause: error });
    throw error;
  }
  return {
    inputRef: workspace.project.inputRef,
    async release(unknown) {
      if (!unknown) await rm(file);
    },
  };
}

/** Unknown executions retain the same workspace and lease for reconciliation. */
export async function releaseSettledProject(
  context: RuntimeContext,
  ref: string,
): Promise<boolean> {
  if ((await context.workspaces.read(ref)).leaseOwner) return false;
  await context.workspaces.release(ref);
  return true;
}
