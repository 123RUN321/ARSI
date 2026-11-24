import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  Candidate,
  DoctorContext,
  DoctorResult,
  Operation,
  RuntimeContext,
} from '../../../contracts/index.js';
import {
  failed,
  passed,
  missingInputError,
  runDoctorCheck,
  runDoctorProbe,
} from '../../../shared/doctor-check.js';
import { object, string } from '../../../shared/json.js';
import { parseConfig } from '../../../shared/schema.js';
import {
  readInstance,
  readTarget,
  type FileApplicationConfig,
} from './files.js';

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function requirePath(
  path: string,
  field: string,
  kind: 'file' | 'directory',
): Promise<void> {
  try {
    const stat = await lstat(path);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
      throw new Error(`${field}: expected a readable ${kind}: ${path}`);
    await access(path, constants.R_OK);
  } catch (error) {
    if (missing(error))
      throw missingInputError({ field, kind, reference: path }, error);
    throw error;
  }
}

export async function checkBaselineDirectory(
  context: DoctorContext,
  entryFile?: string,
): Promise<{
  check: DoctorResult['checks'][number];
  directory?: string;
}> {
  const { check, value: directory } = await runDoctorProbe(
    'baseline',
    (signal) => readBaselineDirectory(context, entryFile, signal),
    { signal: context.signal },
  );
  return { check, directory };
}

async function readBaselineDirectory(
  context: DoctorContext,
  entryFile: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const config = parseConfig<FileApplicationConfig>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const { target } = await readTarget(config, context.runtime.rootDirectory);
  let directory: string;
  if ('directory' in config.baseline) {
    directory = resolve(
      context.runtime.rootDirectory,
      config.baseline.directory,
    );
  } else {
    directory = join(context.directory, 'baseline-input');
    try {
      await context.runtime.artifacts.materialize(
        config.baseline.artifactRef,
        directory,
      );
    } catch (error) {
      if (missing(error))
        throw missingInputError(
          {
            field: 'baseline.artifactRef',
            kind: 'artifact',
            reference: config.baseline.artifactRef,
          },
          error,
        );
      throw error;
    }
  }
  for (const entry of target.entries)
    if (entry.kind === 'file')
      await requirePath(
        join(directory, entry.path),
        `target.entries.${entry.path}`,
        'file',
      );
  if (entryFile)
    await requirePath(
      join(directory, entryFile),
      `baseline.${entryFile}`,
      'file',
    );
  signal.throwIfAborted();
  return directory;
}

export async function checkFileApplication(
  context: DoctorContext,
  application: Operation,
  {
    verification,
    capability,
    entryFile,
  }: { verification: string; capability: string; entryFile: string },
): Promise<DoctorResult> {
  const baseline = await checkBaselineDirectory(context, entryFile);
  if (baseline.check.status === 'failed')
    return failed(
      baseline.check.id,
      baseline.check.reason,
      baseline.check.details,
    );

  const runtime = createApplicationProbeRuntime(context);
  const initialization = await runDoctorProbe(
    verification,
    (signal) => initializeApplication(application, runtime.extend({ signal })),
    { signal: context.signal },
  );
  const candidateRef = initialization.value;
  if (!candidateRef)
    return failed(
      initialization.check.id,
      initialization.check.reason,
      initialization.check.details,
    );

  const instance = await runDoctorCheck(
    'acquire-instance',
    (signal) =>
      verifyApplicationInstance(
        application,
        runtime.extend({ signal }),
        candidateRef,
        capability,
        entryFile,
      ),
    { signal: context.signal },
  );
  if (instance.status === 'failed')
    return failed(instance.id, instance.reason, instance.details);
  return passed(
    'acquire-instance',
    'Baseline, initialization, instance contents and resource release were verified.',
  );
}

function createApplicationProbeRuntime(context: DoctorContext): RuntimeContext {
  const candidates = new Map<string, Candidate>();
  return context.runtime.extend({
    experimentId: `doctor-${randomUUID()}`,
    async recordCandidate(
      artifactRef: string,
      parentRef: string | null,
    ): Promise<string> {
      const ref = `doctor-candidate-${randomUUID()}`;
      candidates.set(ref, {
        ref,
        artifactRef,
        parentRef,
        experimentId: this.experimentId,
      });
      return ref;
    },
    async readCandidate(ref: string): Promise<Candidate> {
      const candidate = candidates.get(ref);
      if (!candidate) throw new Error(`Unknown doctor candidate ${ref}`);
      return candidate;
    },
  });
}

async function initializeApplication(
  application: Operation,
  runtime: RuntimeContext,
): Promise<string> {
  const result = object(
    await application.execute({ action: 'initialize' }, runtime),
  );
  if (result.action !== 'initialize')
    throw new Error(
      'Application returned no initialization result. Check the Application implementation.',
    );
  return string(result.initialCandidateRef, 'initialCandidateRef');
}

async function verifyApplicationInstance(
  application: Operation,
  runtime: RuntimeContext,
  candidateRef: string,
  capability: string,
  entryFile: string,
): Promise<void> {
  const instanceId = `doctor-instance-${randomUUID()}`;
  let acquired = false;
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    const instance = await readInstance(runtime, instanceId);
    if ((acquired || instance) && instance?.status !== 'released')
      throw new Error(
        'Application instance release was not confirmed. Reconcile Application resources before retrying.',
      );
  });
  cleanup.defer(async () => {
    if (acquired)
      await application.execute(
        { action: 'release', instanceId },
        runtime.extend({ signal: runtime.cleanup }),
      );
  });
  const result = object(
    await application.execute(
      {
        action: 'acquire',
        candidateRef,
        instanceId,
        capability,
      },
      runtime,
    ),
  );
  acquired = true;
  const execution = object(result.execution, 'execution');
  const directory = string(execution.directory, 'execution.directory');
  await access(directory, constants.R_OK);
  await readFile(join(directory, entryFile), {
    encoding: 'utf8',
    signal: runtime.signal,
  });
  runtime.signal.throwIfAborted();
}
