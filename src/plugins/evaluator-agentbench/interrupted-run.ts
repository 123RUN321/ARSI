import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { digest, object, string, strings } from '../../shared/json.js';

/** Native SDK resume owns its writer lock, source checks and completed-task
 * skipping. RSI only reattaches after checking the original input/workspace. */
export async function interruptedRun(
  input: JsonObject,
  receipt: JsonObject,
  expected: JsonObject,
  execution: JsonObject,
  context: RuntimeContext,
): Promise<string> {
  if (
    !['running', 'unknown', 'failed', 'cancelled'].includes(
      string(receipt.status),
    ) ||
    receipt.callId !== context.callId ||
    receipt.experimentId !== context.experimentId ||
    digest(receipt.input) !== digest(input)
  )
    throw new Error('Interrupted evaluator receipt identity differs');
  const candidate = await context.readCandidate(string(input.candidateRef));
  if (candidate.artifactRef !== execution.artifactDigest)
    throw new Error('Interrupted evaluator candidate artifact differs');
  const workspace = await context.workspaces.read(
    string(execution.workspaceRef),
  );
  if (
    (await realpath(workspace.directory)) !==
      (await realpath(string(execution.directory))) ||
    (await context.artifacts.capture(workspace.directory)) !==
      execution.artifactDigest
  )
    throw new Error(
      'Interrupted evaluator workspace differs from its candidate',
    );
  const saved = object(
    JSON.parse(
      await readFile(join(context.directory, 'evaluator.json'), 'utf8'),
    ),
  );
  if (digest(saved) !== digest(expected))
    throw new Error('Interrupted evaluator configuration differs');
  const root = join(context.directory, 'sdk');
  const runs = (await readdir(root, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  if (
    runs.length !== 1 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runs[0].name)
  )
    throw new Error('Interrupted evaluator requires exactly one native run');
  const runId = runs[0].name;
  const manifest = object(
    JSON.parse(await readFile(join(root, runId, 'manifest.json'), 'utf8')),
  );
  const selected = strings(manifest.taskIds);
  const requested = strings(input.taskIds);
  if (
    manifest.runId !== runId ||
    new Set(selected).size !== selected.length ||
    selected.length !== requested.length ||
    !requested.every((id) => selected.includes(id))
  )
    throw new Error('Interrupted evaluator native task selection differs');
  context.signal.throwIfAborted();
  return runId;
}
