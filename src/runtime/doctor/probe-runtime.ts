import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeContext } from '../../contracts/index.js';
import type { Runtime } from '../context.js';
import { Manager } from '../manager/index.js';
import { ManagedEvents } from '../services/events.js';

interface CleanupFailure {
  id: string;
  error: unknown;
}

interface ProbeRuntime {
  createBindingContext(
    bindingIndex: number,
    bindingId: string,
  ): Promise<RuntimeContext>;
  dispose(): Promise<CleanupFailure[]>;
}

async function readArtifactWithFallback<T>(
  readFromProbe: () => Promise<T>,
  readFromSource: () => Promise<T>,
): Promise<T> {
  try {
    return await readFromProbe();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    return readFromSource();
  }
}

async function rejectExperimentOperation(): Promise<never> {
  throw new Error('Doctor does not execute Agents, Policies, or Measurements');
}

function createProbeContext(
  sourceRuntime: Runtime,
  probeManager: Manager,
  events: ManagedEvents,
  signal: AbortSignal,
): RuntimeContext {
  const probeArtifacts = probeManager.artifacts;
  return probeManager.context.extend({
    signal,
    cleanup: new AbortController().signal,
    experimentId: 'doctor',
    callId: 'doctor',
    event: events.event,
    // Existing artifacts are inputs. Captures and writes belong to probe storage.
    artifacts: {
      putJson: probeArtifacts.putJson.bind(probeArtifacts),
      capture: probeArtifacts.capture.bind(probeArtifacts),
      readJson: (artifactRef: string) =>
        readArtifactWithFallback(
          () => probeArtifacts.readJson(artifactRef),
          () => sourceRuntime.context.artifacts.readJson(artifactRef),
        ),
      materialize: (artifactRef: string, directory: string) =>
        readArtifactWithFallback(
          () => probeArtifacts.materialize(artifactRef, directory),
          () =>
            sourceRuntime.context.artifacts.materialize(artifactRef, directory),
        ),
    },
    invoke: rejectExperimentOperation,
    invokeAgent: rejectExperimentOperation,
    application: rejectExperimentOperation,
    recordCandidate: rejectExperimentOperation,
    readCandidate: rejectExperimentOperation,
    recordMeasurement: rejectExperimentOperation,
    readMeasurement: rejectExperimentOperation,
    withInstance: rejectExperimentOperation,
    charge: rejectExperimentOperation,
  });
}

async function disposeProbeRuntime(
  temporaryDirectory: string,
  probeManager: Manager | undefined,
  probeEvents: ManagedEvents | undefined,
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  const cleanupResults = await Promise.allSettled([
    probeManager?.dispose(),
    probeEvents?.dispose(),
  ]);
  for (const [cleanupIndex, result] of cleanupResults.entries())
    if (result.status === 'rejected')
      failures.push({
        id: `doctor.cleanup.${cleanupIndex}`,
        error: result.reason,
      });
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    failures.push({ id: 'doctor.cleanup.storage', error });
  }
  return failures;
}

export async function openProbeRuntime(
  sourceRuntime: Runtime,
  signal: AbortSignal,
): Promise<ProbeRuntime> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'arsi-doctor-'));
  let probeManager: Manager | undefined;
  let probeEvents: ManagedEvents | undefined;
  const dispose = (): Promise<CleanupFailure[]> =>
    disposeProbeRuntime(temporaryDirectory, probeManager, probeEvents);

  try {
    const manager = new Manager({
      registry: sourceRuntime.registry,
      rootDirectory: sourceRuntime.context.rootDirectory,
      directory: temporaryDirectory,
    });
    probeManager = manager;
    probeEvents = new ManagedEvents({
      context: () => manager.context,
      diagnostic: ({ error }) => {
        throw error;
      },
    });
    const probeContext = createProbeContext(
      sourceRuntime,
      manager,
      probeEvents,
      signal,
    );
    return {
      async createBindingContext(
        bindingIndex,
        bindingId,
      ): Promise<RuntimeContext> {
        const bindingDirectory = join(
          temporaryDirectory,
          `probe-${bindingIndex}`,
        );
        await mkdir(bindingDirectory);
        return probeContext.extend({ directory: bindingDirectory, bindingId });
      },
      dispose,
    };
  } catch (error) {
    const failures = await dispose();
    if (failures.length)
      throw new AggregateError(
        [error, ...failures.map((failure) => failure.error)],
        'Failed to prepare the doctor probe Runtime',
      );
    throw error;
  }
}
