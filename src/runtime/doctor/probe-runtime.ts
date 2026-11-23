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

interface DoctorProbeRuntime {
  createBindingContext(
    index: number,
    bindingId: string,
  ): Promise<RuntimeContext>;
  dispose(): Promise<CleanupFailure[]>;
}

async function readArtifactInput<T>(
  local: () => Promise<T>,
  original: () => Promise<T>,
): Promise<T> {
  try {
    return await local();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    return original();
  }
}

async function denyExecution(): Promise<never> {
  throw new Error('Doctor does not execute Agents, Policies, or Measurements');
}

function createProbeContext(
  runtime: Runtime,
  isolated: Manager,
  events: ManagedEvents,
  signal: AbortSignal,
): RuntimeContext {
  const artifacts = isolated.artifacts;
  return isolated.context.extend({
    signal,
    cleanup: new AbortController().signal,
    experimentId: 'doctor',
    callId: 'doctor',
    event: events.event,
    // Existing artifacts are inputs. Captures and writes belong to probe storage.
    artifacts: {
      putJson: artifacts.putJson.bind(artifacts),
      capture: artifacts.capture.bind(artifacts),
      readJson: (ref: string) =>
        readArtifactInput(
          () => artifacts.readJson(ref),
          () => runtime.context.artifacts.readJson(ref),
        ),
      materialize: (ref: string, directory: string) =>
        readArtifactInput(
          () => artifacts.materialize(ref, directory),
          () => runtime.context.artifacts.materialize(ref, directory),
        ),
    },
    invoke: denyExecution,
    invokeAgent: denyExecution,
    application: denyExecution,
    recordCandidate: denyExecution,
    readCandidate: denyExecution,
    recordMeasurement: denyExecution,
    readMeasurement: denyExecution,
    withInstance: denyExecution,
    charge: denyExecution,
  });
}

async function closeProbeRuntime(
  directory: string,
  manager: Manager | undefined,
  events: ManagedEvents | undefined,
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  const cleanups = await Promise.allSettled([
    manager?.dispose(),
    events?.dispose(),
  ]);
  for (const [index, result] of cleanups.entries())
    if (result.status === 'rejected')
      failures.push({ id: `doctor.cleanup.${index}`, error: result.reason });
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    failures.push({ id: 'doctor.cleanup.storage', error });
  }
  return failures;
}

export async function openDoctorProbeRuntime(
  runtime: Runtime,
  signal: AbortSignal,
): Promise<DoctorProbeRuntime> {
  const temporary = await mkdtemp(join(tmpdir(), 'arsi-doctor-'));
  let manager: Manager | undefined;
  let events: ManagedEvents | undefined;
  const dispose = (): Promise<CleanupFailure[]> =>
    closeProbeRuntime(temporary, manager, events);

  try {
    const isolated = new Manager({
      registry: runtime.registry,
      rootDirectory: runtime.context.rootDirectory,
      directory: temporary,
    });
    manager = isolated;
    events = new ManagedEvents({
      context: () => isolated.context,
      diagnostic: ({ error }) => {
        throw error;
      },
    });
    const base = createProbeContext(runtime, isolated, events, signal);
    return {
      async createBindingContext(index, bindingId): Promise<RuntimeContext> {
        const directory = join(temporary, `probe-${index}`);
        await mkdir(directory);
        return base.extend({ directory, bindingId });
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
