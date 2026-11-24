import type {
  DoctorBinding,
  DoctorCheck,
  DoctorReport,
  DoctorResult,
  JsonSchema,
  JsonValue,
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
  return {
    ...localCheck,
    binding: binding.name,
    pluginId: binding.pluginId,
    id: `${binding.name}.${localCheck.id}`,
  };
}

/** Validate and redact checks before adding them to the report. */
export class DoctorReportBuilder {
  private readonly checksById = new Map<string, DoctorCheck>();
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

  addBindingResult(binding: DoctorBinding, bindingResult: DoctorResult): void {
    validate(doctorResultSchema, bindingResult, 'Doctor result');
    // Validate the whole callback result before recording any of its checks.
    const batchIds = new Set<string>();
    const validatedChecks: DoctorCheck[] = [];
    for (const localCheck of bindingResult.checks) {
      const bindingCheck = qualifyBindingCheck(binding, localCheck);
      if (localCheck.details !== undefined) json(localCheck.details);
      if (this.checksById.has(bindingCheck.id) || batchIds.has(bindingCheck.id))
        throw new Error(`Duplicate doctor check ID: ${bindingCheck.id}`);
      batchIds.add(bindingCheck.id);
      validatedChecks.push(bindingCheck);
    }
    for (const check of validatedChecks) this.storeCheck(check);
  }

  build(): DoctorReport {
    return {
      recipeId: this.recipeId,
      checks: [...this.checksById.values()],
    };
  }

  private storeCheck(check: DoctorCheck): void {
    const { reason, details, ...metadata } = check;
    this.checksById.set(check.id, {
      ...metadata,
      ...(reason ? { reason: this.redactText(reason) } : {}),
      ...(details ? { details: object(this.redactJson(details)) } : {}),
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
