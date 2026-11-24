import { parse, sep } from 'node:path';
import type {
  DoctorBinding,
  DoctorCheck,
  DoctorReport,
  DoctorResult,
  JsonSchema,
  JsonValue,
  MissingResource,
} from '../../contracts/index.js';
import { errorText, redactConfiguration } from '../../shared/errors.js';
import { json, object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';

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

type LocalCheck = DoctorResult['checks'][number];

export function createFailureReport(
  checkId: string,
  error: unknown,
): DoctorReport {
  return {
    recipeId: null,
    checks: [
      {
        id: checkId,
        status: 'failed',
        reason: redactConfiguration()(errorText(error)),
      },
    ],
  };
}

function qualifyBindingCheck(
  binding: DoctorBinding,
  localCheck: LocalCheck,
): DoctorCheck {
  const { missingResource, blockedBy, ...checkFields } = localCheck;
  return {
    ...checkFields,
    binding: binding.name,
    pluginId: binding.pluginId,
    id: `${binding.name}.${localCheck.id}`,
    ...(blockedBy ? { blockedBy: `${binding.name}.${blockedBy}` } : {}),
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
  };
}

function missingResourceKey({ kind, reference }: MissingResource): string {
  if (!['file', 'directory', 'path'].includes(kind))
    return JSON.stringify([kind, reference]);

  const localPath = sep === '\\' ? reference.replaceAll('\\', '/') : reference;
  const { root } = parse(localPath);
  const normalizedPath =
    root + localPath.slice(root.length).replace(/\/+$/, '');
  return JSON.stringify(['path', normalizedPath]);
}

/** Collect checks in dispatch order and resolve blockers after deduplication. */
export class DoctorReportBuilder {
  private readonly checksById = new Map<string, DoctorCheck>();
  private readonly firstIdByMissingResource = new Map<string, string>();
  private readonly originalIdByDuplicateId = new Map<string, string>();
  private readonly redactText: (message: string) => string;

  constructor(
    private readonly recipeId: string,
    configuration: JsonValue,
  ) {
    this.redactText = redactConfiguration(configuration);
  }

  addCheck(check: DoctorCheck): void {
    if (this.checksById.has(check.id))
      throw new Error(`Duplicate doctor check ID: ${check.id}`);
    this.storeCheck(check);
  }

  addBindingCheck(binding: DoctorBinding, localCheck: LocalCheck): void {
    this.addCheck(qualifyBindingCheck(binding, localCheck));
  }

  addBindingResult(
    binding: DoctorBinding,
    bindingResult: DoctorResult,
    failedPrerequisites: readonly string[],
  ): void {
    validate(doctorResultSchema, bindingResult, 'Doctor result');
    // Validate the whole callback result before recording any of its checks.
    const failedLocalIds = new Set([
      ...failedPrerequisites,
      ...bindingResult.checks
        .filter(({ status }) => status === 'failed')
        .map(({ id }) => id),
    ]);
    const batchIds = new Set<string>();
    const validatedChecks: DoctorCheck[] = [];
    for (const localCheck of bindingResult.checks) {
      const bindingCheck = qualifyBindingCheck(binding, localCheck);
      if (localCheck.details !== undefined) json(localCheck.details);
      if (this.checksById.has(bindingCheck.id) || batchIds.has(bindingCheck.id))
        throw new Error(`Duplicate doctor check ID: ${bindingCheck.id}`);
      batchIds.add(bindingCheck.id);
      if (localCheck.missingResource && localCheck.status !== 'failed')
        throw new Error(
          `Only a failed check can report a missing resource: ${bindingCheck.id}`,
        );
      if (
        localCheck.blockedBy &&
        (localCheck.status !== 'unchecked' ||
          !failedLocalIds.has(localCheck.blockedBy))
      )
        throw new Error(
          `An unchecked check must reference a failed blocker: ${bindingCheck.id}`,
        );
      validatedChecks.push(bindingCheck);
    }
    for (const check of validatedChecks) this.storeCheck(check);
  }

  build(): DoctorReport {
    return {
      recipeId: this.recipeId,
      checks: [...this.checksById.values()].map((check) => {
        const originalBlockerId =
          check.blockedBy && this.originalIdByDuplicateId.get(check.blockedBy);
        return originalBlockerId
          ? { ...check, blockedBy: originalBlockerId }
          : check;
      }),
    };
  }

  private storeCheck(check: DoctorCheck): void {
    const { reason, details, missingResource, ...metadata } = check;
    if (missingResource) {
      const resourceKey = missingResourceKey(missingResource);
      const firstCheckId = this.firstIdByMissingResource.get(resourceKey);
      if (firstCheckId) {
        this.originalIdByDuplicateId.set(check.id, firstCheckId);
        this.checksById.set(check.id, {
          ...metadata,
          status: 'unchecked',
          blockedBy: firstCheckId,
        });
        return;
      }
      this.firstIdByMissingResource.set(resourceKey, check.id);
    }
    this.checksById.set(check.id, {
      ...metadata,
      ...(reason ? { reason: this.redactText(reason) } : {}),
      ...(details ? { details: object(this.redactJson(details)) } : {}),
      ...(missingResource
        ? {
            missingResource: {
              ...missingResource,
              reference: this.redactText(missingResource.reference),
            },
          }
        : {}),
    });
  }

  private redactJson(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value))
      return value.map((entry) => this.redactJson(entry));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          this.redactJson(child),
        ]),
      );
    return value;
  }
}
