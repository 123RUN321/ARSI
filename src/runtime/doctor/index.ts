import { mkdtemp, mkdir, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { constants } from 'node:fs';
import { join, parse, resolve, sep } from 'node:path';
import type { JsonSchema, JsonValue } from '../../contracts/index.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';
import {
  DoctorMissingResourceError,
  runDoctorCheck,
} from '../../shared/doctor-check.js';
import { errorText, redactConfiguration } from '../../shared/errors.js';
import { json, object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import type { Registry } from '../registry/index.js';
import type { Runtime } from '../context.js';
import { Recipe } from '../loaders/recipe.js';
import { Manager } from '../manager/index.js';
import { withBindingInstance } from '../manager/instances.js';
import type {
  DoctorBinding,
  DoctorCheck,
  DoctorContext,
  DoctorReport,
  DoctorResult,
} from '../../contracts/index.js';

const doctorResultSchema: JsonSchema = {
  type: 'object',
  required: ['checks'],
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          status: { enum: ['passed', 'failed', 'unchecked'] },
          reason: { type: 'string' },
          details: { type: 'object' },
          missingResource: {
            type: 'object',
            required: ['field', 'kind', 'reference'],
            additionalProperties: false,
            properties: {
              field: { type: 'string', minLength: 1 },
              kind: { type: 'string', minLength: 1 },
              reference: { type: 'string', minLength: 1 },
            },
          },
          blockedBy: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

export function doctorFailure(stage: string, error: unknown): DoctorReport {
  return {
    recipeId: null,
    checks: [
      {
        id: stage,
        status: 'failed',
        reason: redactConfiguration()(errorText(error)),
      },
    ],
  };
}

export async function diagnoseBinding(
  registry: Registry,
  context: DoctorContext,
): Promise<DoctorResult> {
  const { binding, signal, directory } = context;
  try {
    const result = await withBindingInstance(
      registry,
      { plugin: binding.pluginId, config: binding.config },
      context.runtime.extend({ bindingId: binding.name, signal, directory }),
      'rsi/doctor',
      (target, event, runtime) =>
        target.serial(target, event, { ...context, runtime }),
    );
    return (
      result ?? {
        checks: [
          {
            id: 'plugin',
            status: 'unchecked',
            reason: `Binding ${binding.name}, implementation ${binding.pluginId}, has no doctor capability.`,
          },
        ],
      }
    );
  } catch (error) {
    signal.throwIfAborted();
    return {
      checks: [{ id: 'script', status: 'failed', reason: errorText(error) }],
    };
  }
}

/** Internal runner: never runs a Policy or writes to the invoking experiment store. */
export async function doctorRecipe(
  runtime: Runtime,
  path: string,
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<DoctorReport> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  let recipe: Recipe;
  try {
    recipe = await Recipe.load(resolve(path), runtime.registry);
  } catch (error) {
    signal.throwIfAborted();
    return doctorFailure('recipe.validate', error);
  }
  const report: DoctorReport = {
    recipeId: recipe.id,
    checks: [{ id: 'recipe.validate', status: 'passed' }],
  };
  const redact = redactConfiguration({
    recipe: recipe.toJSON(),
    reflection: recipe.reflection?.implementation.config ?? {},
  });
  const bindings: DoctorBinding[] = [
    recipe.application,
    ...Object.values(recipe.bindings),
  ];
  if (recipe.reflection) {
    const implementation = recipe.reflection.implementation;
    bindings.push({
      name: 'reflection',
      pluginId: implementation.ref,
      definition: runtime.registry.get(implementation.ref),
      config: implementation.config,
    });
  }
  const temporary = await mkdtemp(join(tmpdir(), 'arsi-doctor-'));
  const isolated = new Manager({
    registry: runtime.registry,
    rootDirectory: runtime.context.rootDirectory,
    directory: temporary,
  });
  // Artifact references may be original inputs; every capture/write stays in probe storage.
  const artifacts = isolated.artifacts;
  const readInput = async <T>(
    local: () => Promise<T>,
    original: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await local();
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
      return original();
    }
  };
  const denied = async (): Promise<never> => {
    throw new Error(
      'Doctor does not execute Agents, Policies, or Measurements',
    );
  };
  const base = isolated.context.extend({
    signal,
    cleanup: new AbortController().signal,
    experimentId: 'doctor',
    callId: 'doctor',
    artifacts: {
      putJson: artifacts.putJson.bind(artifacts),
      capture: artifacts.capture.bind(artifacts),
      readJson: (ref: string) =>
        readInput(
          () => artifacts.readJson(ref),
          () => runtime.context.artifacts.readJson(ref),
        ),
      materialize: (ref: string, directory: string) =>
        readInput(
          () => artifacts.materialize(ref, directory),
          () => runtime.context.artifacts.materialize(ref, directory),
        ),
    },
    invoke: denied,
    invokeAgent: denied,
    application: denied,
    recordCandidate: denied,
    readCandidate: denied,
    recordMeasurement: denied,
    readMeasurement: denied,
    withInstance: denied,
    charge: denied,
  });
  const missingChecks = new Map<string, string>();
  const duplicateChecks = new Map<string, string>();
  const add = (check: DoctorCheck): void => {
    if (report.checks.some((entry) => entry.id === check.id))
      throw new Error(`Duplicate doctor check ID: ${check.id}`);
    const { reason, details, missingResource, ...metadata } = check;
    if (missingResource) {
      const { kind, reference } = missingResource;
      const local = ['file', 'directory', 'path'].includes(kind);
      let keyReference = reference;
      if (local) {
        if (sep === '\\') keyReference = keyReference.replaceAll('\\', '/');
        const { root } = parse(keyReference);
        keyReference =
          root + keyReference.slice(root.length).replace(/\/+$/, '');
      }
      const key = JSON.stringify([local ? 'path' : kind, keyReference]);
      const first = missingChecks.get(key);
      if (first) {
        duplicateChecks.set(check.id, first);
        report.checks.push({
          ...metadata,
          status: 'unchecked',
          blockedBy: first,
        });
        return;
      }
      missingChecks.set(key, check.id);
    }
    report.checks.push({
      ...metadata,
      ...(reason ? { reason: redact(reason) } : {}),
      ...(details ? { details: object(redactValues(details)) } : {}),
      ...(missingResource
        ? {
            missingResource: {
              ...missingResource,
              reference: redact(missingResource.reference),
            },
          }
        : {}),
    });
  };
  const redactValues = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redactValues);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, redactValues(child)]),
      );
    return value;
  };
  try {
    for (const [index, binding] of bindings.entries()) {
      signal.throwIfAborted();
      const directory = join(temporary, `probe-${index}`);
      await mkdir(directory);
      const scoped = (id: string): string => `${binding.name}.${id}`;
      const identity = { binding: binding.name, pluginId: binding.pluginId };
      const addCheck = (check: DoctorResult['checks'][number]): void => {
        const { missingResource, blockedBy, ...result } = check;
        add({
          ...result,
          ...identity,
          id: scoped(check.id),
          ...(blockedBy ? { blockedBy: scoped(blockedBy) } : {}),
          ...(missingResource
            ? {
                missingResource: {
                  ...missingResource,
                  field: missingResource.field.startsWith('application.config.')
                    ? missingResource.field
                    : `${binding.name}.config.${missingResource.field}`,
                },
              }
            : {}),
        });
      };
      let pathBlocker: string | undefined;
      for (const field of configPathFields(
        binding.definition.configSchema,
        binding.config,
      )) {
        let value: JsonValue = binding.config;
        for (const part of field.pointer.slice(1).split('/')) {
          const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
          if (value === null || typeof value !== 'object')
            throw new Error(`Invalid resolved path ${field.pointer}`);
          value = Array.isArray(value) ? value[Number(key)] : value[key];
        }
        if (typeof value !== 'string' || isResourceUrl(value)) continue;
        const reference = value;
        const id = `resource${field.pointer.replaceAll('/', '.')}`;
        const check = await runDoctorCheck(
          id,
          async () => {
            try {
              const info = await stat(reference);
              if (!(field.kind === 'file' ? info.isFile() : info.isDirectory()))
                throw new Error(
                  `${field.pointer}: expected ${field.kind}: ${reference}`,
                );
              await access(reference, constants.R_OK);
            } catch (error) {
              if (
                error instanceof Error &&
                'code' in error &&
                error.code === 'ENOENT'
              )
                throw new DoctorMissingResourceError(
                  {
                    field: field.pointer.slice(1).replaceAll('/', '.'),
                    kind: field.kind,
                    reference,
                  },
                  error,
                );
              throw error;
            }
          },
          { signal },
        );
        addCheck(check);
        if (check.status === 'failed') pathBlocker ??= check.id;
      }
      if (pathBlocker) {
        addCheck({
          id: 'plugin',
          status: 'unchecked',
          blockedBy: pathBlocker,
        });
        continue;
      }
      const context: DoctorContext = {
        binding,
        recipe,
        registry: runtime.registry,
        directory,
        signal,
        runtime: base,
      };
      try {
        const result = await diagnoseBinding(runtime.registry, context);
        signal.throwIfAborted();
        validate(doctorResultSchema, result, 'Doctor result');
        const ids = new Set(report.checks.map(({ id }) => id));
        const failed = new Set(
          result.checks
            .filter((check) => check.status === 'failed')
            .map((check) => check.id),
        );
        for (const check of result.checks) {
          if (check.details !== undefined) json(check.details);
          const id = scoped(check.id);
          if (ids.has(id)) throw new Error(`Duplicate doctor check ID: ${id}`);
          ids.add(id);
          if (check.missingResource && check.status !== 'failed')
            throw new Error(
              `Only a failed check can report a missing resource: ${id}`,
            );
          if (
            check.blockedBy &&
            (check.status !== 'unchecked' || !failed.has(check.blockedBy))
          )
            throw new Error(
              `An unchecked check must reference a failed blocker: ${id}`,
            );
        }
        for (const check of result.checks) addCheck(check);
      } catch (error) {
        signal.throwIfAborted();
        addCheck({
          id: 'script',
          status: 'failed',
          reason: errorText(error),
        });
      }
    }
  } finally {
    try {
      await isolated.dispose();
    } catch (error) {
      add({
        id: 'doctor.cleanup.runtime',
        status: 'failed',
        reason: errorText(error),
      });
    }
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      add({
        id: 'doctor.cleanup.storage',
        status: 'failed',
        reason: errorText(error),
      });
    }
  }
  signal.throwIfAborted();
  for (const check of report.checks) {
    if (check.blockedBy)
      check.blockedBy = duplicateChecks.get(check.blockedBy) ?? check.blockedBy;
  }
  return report;
}
