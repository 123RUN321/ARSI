import { checkTarget, type TargetEntry } from '../file-application/target.js';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentInput,
  RuntimeContext,
  JsonObject,
  JsonSchema,
  JsonValue,
} from '../../../contracts/index.js';
import { parseFileTree } from '../../../contracts/index.js';
import { canonical, object, string, strings } from '../../../shared/json.js';
import {
  prepareAgentProject,
  releaseSettledProject,
  type AgentRole,
} from './project.js';
import type { AgentEditingConfig } from './schema.js';
export { agentConfigSchema, type AgentEditingConfig } from './schema.js';
export const editOutputSchema = {
  type: 'object',
  properties: { reason: { type: 'string' } },
  required: ['reason'],
  additionalProperties: false,
} satisfies JsonSchema;
export interface EditedProject {
  result: JsonObject;
  editRef: string;
}
export interface ReadOnlyEditContext {
  files: JsonObject;
  evidence: JsonValue;
  input: JsonObject;
}
/** Include source executions when an editor composes other proposals. */
export function editEvidenceRefs(input: JsonObject): string[] {
  return [
    ...new Set([
      ...strings(input.evidenceRefs ?? []),
      ...(Array.isArray(input.sources)
        ? input.sources
            .map((v) => object(v).measurementRef)
            .filter((v): v is string => typeof v === 'string')
        : []),
    ]),
  ];
}
/** Reload plugin-owned guidance for each request without changing the base prompt. */
export async function loadAgentPrompt(
  config: AgentEditingConfig,
): Promise<string> {
  const prompt = await readFile(config.prompt, 'utf8');
  if (config.guidance === undefined) return prompt;
  const directory = config.guidance;
  const files: string[] = [];
  async function collect(path: string, relative: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error(`Agent guidance cannot follow a symbolic link: ${path}`);
    if (stat.isDirectory()) {
      for (const name of await readdir(path))
        await collect(
          join(path, name),
          relative ? `${relative}/${name}` : name,
        );
    } else if (stat.isFile()) {
      if (relative.toLowerCase().endsWith('.md')) files.push(relative);
    } else throw new Error(`Agent guidance requires ordinary files: ${path}`);
  }
  const root = await lstat(directory);
  if (root.isSymbolicLink())
    throw new Error(
      `Agent guidance cannot follow a symbolic link: ${directory}`,
    );
  if (!root.isDirectory())
    throw new Error(`Agent guidance must be a directory: ${directory}`);
  await collect(directory, '');
  const guidance: string[] = [];
  for (const file of files.sort()) {
    const content = await readFile(join(directory, file), 'utf8');
    if (content.trim()) guidance.push(`### ${file}\n\n${content}`);
  }
  return guidance.length
    ? `${prompt}\n\n## Guidance\n\n${guidance.join('\n\n')}`
    : prompt;
}
export async function resourceFiles(
  ref: string | null,
  services: RuntimeContext,
): Promise<JsonObject> {
  if (ref === null) return {};
  const tree = parseFileTree(await services.artifacts.readJson(ref));
  const files: JsonObject = {};
  for (const f of tree.files) {
    const content = Buffer.from(f.base64, 'base64');
    if (content.includes(0)) continue;
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      continue;
    }
    files[string(f.path)] = decoded;
  }
  return files;
}
function projectJson(value: JsonValue): string {
  // Fact storage can reorder keys on resume; project bytes identify Agent calls.
  return JSON.stringify(JSON.parse(canonical(value)), null, 2);
}

export async function requestEdit(
  config: AgentEditingConfig,
  input: JsonObject,
  ref: string | null,
  context: RuntimeContext,
  readOnly?: ReadOnlyEditContext,
  outputSchema: JsonSchema = editOutputSchema,
  roles: readonly AgentRole[] = [],
): Promise<EditedProject> {
  const files = await resourceFiles(ref, context);
  if (readOnly)
    for (const [path, content] of Object.entries(readOnly.files)) {
      if (Object.hasOwn(files, path))
        throw new Error('Read-only context shadows an editable file');
      files[path] = content;
    }
  const evidence =
    readOnly?.evidence ??
    (await context.readEvidence(editEvidenceRefs(input), {
      view: config.evidenceView ?? 'execution',
    }));
  const memory = input.memoryRef
    ? await resourceFiles(string(input.memoryRef), context)
    : null;
  const sources: JsonObject[] = [];
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources))
      throw new Error('sources must be an array');
    if (
      input.sources.length > 0 &&
      Object.keys(files).some(
        (path) => path === 'sources' || path.startsWith('sources/'),
      )
    )
      throw new Error('Read-only source context shadows an editable file');
    for (let i = 0; i < input.sources.length; i++) {
      const source = object(input.sources[i]);
      const candidate = await context.readCandidate(
        string(source.candidateRef),
      );
      const contents = await resourceFiles(candidate.artifactRef, context);
      const names = Object.keys(contents).sort();
      for (const name of names) files[`sources/${i}/${name}`] = contents[name];
      sources.push({
        candidateRef: candidate.ref,
        files: names.map((name) => `sources/${i}/${name}`),
        measurementRef: source.measurementRef ?? null,
      });
    }
  }
  const prompt = await loadAgentPrompt(config);
  const metadata = {
    target: input.target ?? null,
    memory,
    sources,
    editConstraints: input.editConstraints ?? {},
    observations: input.observations ?? null,
    ...(input.maxCandidates === undefined
      ? {}
      : { maxCandidates: input.maxCandidates }),
    ...(input.proposalIndex === undefined
      ? {}
      : { proposalIndex: input.proposalIndex }),
    ...readOnly?.input,
  };
  const projectFiles: JsonObject = {
    'context/measurements.json': projectJson(evidence),
    'context/input.json': projectJson(metadata),
  };
  for (const [path, content] of Object.entries(files)) {
    const contextPath =
      Object.hasOwn(readOnly?.files ?? {}, path) ||
      (sources.length > 0 && path.startsWith('sources/'));
    if (contextPath) projectFiles[path] = content;
  }
  const guide = `## Project input

Read context/input.json and context/measurements.json. Treat context and source evidence as read-only data. Edit files directly under candidate/. Use scratch/ for temporary work. Return only the requested result JSON; do not return edits.`;
  const projectRef = await prepareAgentProject(
    context,
    `${prompt}\n\n${guide}`,
    projectFiles,
    config.skills ?? [],
    roles,
    ref === null
      ? undefined
      : {
          artifactRef: ref,
          ...(typeof input.parent === 'string'
            ? { parentCandidateRef: input.parent }
            : {}),
        },
  );
  try {
    const request: AgentInput = {
      goal: string(input.goal),
      projectRef,
      mode: 'edit',
      outputSchema: object(outputSchema),
    };
    const result = await context.invokeAgent(
      config.agentRef ?? 'agent.default',
      request,
    );
    return { result, editRef: projectRef };
  } catch (error) {
    await releaseSettledProject(context, projectRef);
    throw error;
  }
}
export async function editResource(
  config: AgentEditingConfig,
  input: JsonObject,
  ref: string | null,
  context: RuntimeContext,
  readOnly?: ReadOnlyEditContext,
  roles?: readonly AgentRole[],
): Promise<{
  resourceRef: string | null;
  changeRef: string | null;
  reason: string;
}> {
  const edited = await requestEdit(
    config,
    input,
    ref,
    context,
    readOnly,
    editOutputSchema,
    roles,
  );
  try {
    const workspace = await context.workspaces.read(edited.editRef);
    const updated = await context.artifacts.capture(workspace.directory);
    const old =
      ref ??
      (await context.artifacts.putJson({ kind: 'file-tree', files: [] }));
    if (updated === old)
      return {
        resourceRef: ref,
        changeRef: null,
        reason: string(edited.result.reason),
      };
    const beforeTree = parseFileTree(await context.artifacts.readJson(old));
    const afterTree = parseFileTree(await context.artifacts.readJson(updated));
    const paths = [
      ...new Set(
        [...beforeTree.files, ...afterTree.files].map((file) => file.path),
      ),
    ];
    const entries = new Map<string, TargetEntry>();
    for (const path of paths) {
      const directory = path.includes('/');
      const root = directory ? path.split('/')[0]! : path;
      entries.set(root, {
        path: root,
        kind: directory ? 'directory' : 'file',
        description: '',
        changes: ['create', 'modify', 'delete'],
        include: ['**'],
        minBytes: 0,
      });
    }
    const tree = (value: typeof beforeTree) =>
      Object.fromEntries(
        value.files.map((file) => [
          file.path,
          { content: file.base64, mode: file.mode },
        ]),
      );
    const changes = checkTarget(
      tree(beforeTree),
      tree(afterTree),
      {
        id: 'agent-resource',
        entries: [...entries.values()],
        protected: [
          'context',
          'context/**',
          'sources',
          'sources/**',
          ...Object.keys(readOnly?.files ?? {}),
        ],
      },
      input.editConstraints === undefined ? {} : object(input.editConstraints),
    );
    const changeRef = await context.artifacts.putJson({
      before: ref,
      after: updated,
      changes,
    });
    return {
      resourceRef: updated,
      changeRef,
      reason: string(edited.result.reason),
    };
  } finally {
    await context.workspaces.release(edited.editRef);
  }
}

export function operationSchema(
  properties: JsonObject,
  required: string[],
): JsonObject {
  return { type: 'object', properties, required, additionalProperties: false };
}
export const refSchema: JsonObject = { type: 'string', minLength: 1 };
