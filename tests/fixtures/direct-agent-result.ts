import { agentContract } from '../../src/contracts/index.js';
import { parseConfig } from '../../src/shared/schema.js';
import { readFile } from 'node:fs/promises';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentInput,
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../src/contracts/index.js';
import { object } from '../../src/shared/json.js';
import { safePath } from '../../src/plugins/shared/file-application/target.js';

/** A controlled Agent fixture performs its chosen file actions, like a native tool would. */
export async function directAgentResult(
  context: RuntimeContext,
  input: JsonValue,
  value: JsonObject,
): Promise<JsonObject> {
  if (!Array.isArray(value.edits) && !Array.isArray(value.proposals))
    return value;
  const request = parseConfig<AgentInput>(
    agentContract.input_schema,
    input,
    'fixture Agent request',
  );
  if (Array.isArray(value.proposals)) {
    const workspace = await context.workspaces.read(request.projectRef);
    const metadata = object(
      JSON.parse(
        await readFile(
          join(dirname(workspace.directory), 'context', 'input.json'),
          'utf8',
        ),
      ),
    );
    value = object(
      value.proposals[Number(metadata.proposalIndex ?? 0)] ?? {
        reason: 'No change',
      },
    );
  }
  if (!Array.isArray(value.edits)) return value;
  if (request.mode !== 'edit')
    throw new Error('Read-only Agent fixture cannot edit files');
  const workspace = await context.workspaces.read(request.projectRef);
  for (const raw of value.edits) {
    const edit = object(raw);
    const path = join(workspace.directory, safePath(edit.path));
    if (edit.content === null || edit.op === 'delete') await rm(path);
    else {
      await mkdir(dirname(path), { recursive: true });
      if (typeof edit.content !== 'string')
        throw new Error('Invalid fixture content');
      await writeFile(path, edit.content);
    }
  }
  const { edits: _edits, ...result } = value;
  return result;
}
