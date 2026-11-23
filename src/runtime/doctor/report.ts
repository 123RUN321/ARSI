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
import { errorText } from '../../shared/errors.js';
import { json, object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { createDoctorRedactor } from './redaction.js';

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

type BindingCheck = DoctorResult['checks'][number];

export function doctorFailure(stage: string, error: unknown): DoctorReport {
  return {
    recipeId: null,
    checks: [
      {
        id: stage,
        status: 'failed',
        reason: createDoctorRedactor()(errorText(error)),
      },
    ],
  };
}

function scopeCheck(binding: DoctorBinding, check: BindingCheck): DoctorCheck {
  const { missingResource, blockedBy, ...result } = check;
  return {
    ...result,
    binding: binding.name,
    pluginId: binding.pluginId,
    id: `${binding.name}.${check.id}`,
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

function resourceKey({ kind, reference }: MissingResource): string {
  if (!['file', 'directory', 'path'].includes(kind))
    return JSON.stringify([kind, reference]);

  const path = sep === '\\' ? reference.replaceAll('\\', '/') : reference;
  const { root } = parse(path);
  const normalized = root + path.slice(root.length).replace(/\/+$/, '');
  return JSON.stringify(['path', normalized]);
}

/** Collect checks in dispatch order and resolve blockers after deduplication. */
export class DoctorReportBuilder {
  private readonly checks = new Map<string, DoctorCheck>();
  private readonly missingResources = new Map<string, string>();
  private readonly duplicateChecks = new Map<string, string>();
  private readonly redact: (message: string) => string;

  constructor(
    private readonly recipeId: string,
    configuration: JsonValue,
  ) {
    this.redact = createDoctorRedactor(configuration);
  }

  add(check: DoctorCheck): void {
    if (this.checks.has(check.id))
      throw new Error(`Duplicate doctor check ID: ${check.id}`);
    this.append(check);
  }

  addBindingCheck(binding: DoctorBinding, check: BindingCheck): void {
    this.add(scopeCheck(binding, check));
  }

  addPluginResult(binding: DoctorBinding, result: DoctorResult): void {
    validate(doctorResultSchema, result, 'Doctor result');
    // Validate the whole callback result before recording any of its checks.
    const failed = new Set(
      result.checks
        .filter(({ status }) => status === 'failed')
        .map(({ id }) => id),
    );
    const ids = new Set<string>();
    const checks: DoctorCheck[] = [];
    for (const check of result.checks) {
      const scoped = scopeCheck(binding, check);
      if (check.details !== undefined) json(check.details);
      if (this.checks.has(scoped.id) || ids.has(scoped.id))
        throw new Error(`Duplicate doctor check ID: ${scoped.id}`);
      ids.add(scoped.id);
      if (check.missingResource && check.status !== 'failed')
        throw new Error(
          `Only a failed check can report a missing resource: ${scoped.id}`,
        );
      if (
        check.blockedBy &&
        (check.status !== 'unchecked' || !failed.has(check.blockedBy))
      )
        throw new Error(
          `An unchecked check must reference a failed blocker: ${scoped.id}`,
        );
      checks.push(scoped);
    }
    for (const check of checks) this.append(check);
  }

  build(): DoctorReport {
    return {
      recipeId: this.recipeId,
      checks: [...this.checks.values()].map((check) => {
        const blocker =
          check.blockedBy && this.duplicateChecks.get(check.blockedBy);
        return blocker ? { ...check, blockedBy: blocker } : check;
      }),
    };
  }

  private append(check: DoctorCheck): void {
    const { reason, details, missingResource, ...metadata } = check;
    if (missingResource) {
      const key = resourceKey(missingResource);
      const first = this.missingResources.get(key);
      if (first) {
        this.duplicateChecks.set(check.id, first);
        this.checks.set(check.id, {
          ...metadata,
          status: 'unchecked',
          blockedBy: first,
        });
        return;
      }
      this.missingResources.set(key, check.id);
    }
    this.checks.set(check.id, {
      ...metadata,
      ...(reason ? { reason: this.redact(reason) } : {}),
      ...(details ? { details: object(this.redactValue(details)) } : {}),
      ...(missingResource
        ? {
            missingResource: {
              ...missingResource,
              reference: this.redact(missingResource.reference),
            },
          }
        : {}),
    });
  }

  private redactValue(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value))
      return value.map((entry) => this.redactValue(entry));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          this.redactValue(child),
        ]),
      );
    return value;
  }
}
