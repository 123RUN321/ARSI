import { stripVTControlCharacters } from 'node:util';
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

export function formatDoctorSummary(
  report: DoctorReport,
  recipePath: string,
): string {
  const failed = report.checks.filter((check) => check.status === 'failed');
  const unchecked = report.checks.filter(
    (check) => check.status === 'unchecked',
  );
  const passed = report.checks.length - failed.length - unchecked.length;
  const result = failed.length ? 'failures' : 'no failures';
  const displayPath = redactConfiguration()(recipePath);
  const lines = [
    `Doctor found ${result} for ${report.recipeId ?? displayPath}.`,
    `${passed} passed, ${failed.length} failed, ${unchecked.length} unchecked.`,
  ];

  if (failed.length) lines.push('', 'Failed checks');
  for (const check of failed) {
    lines.push(describeCheck(check));
    if (check.id === 'recipe.validate') {
      lines.push(
        `  Fix: Check ${displayPath} and correct the path or configuration named in the error.`,
      );
    } else if (check.id === 'runtime.registration') {
      lines.push(
        '  Fix: Check the component or extension named in the error and verify its installation.',
      );
    }
    lines.push(...describeProbes(check));
    if (check.binding)
      lines.push(
        '  Subsequent checks for this plugin were not completed. Correct the failure and rerun doctor.',
      );
  }

  if (unchecked.length) lines.push('', 'Unchecked checks');
  for (const check of unchecked) {
    lines.push(describeCheck(check), ...describeProbes(check));
  }
  return (
    lines
      .map((line) => stripVTControlCharacters(line).replace(/\p{Cc}/gu, ' '))
      .join('\n') + '\n'
  );
}

function describeCheck(check: DoctorCheck): string {
  const scope = check.pluginId ? `${check.id} (${check.pluginId})` : check.id;
  return check.reason ? `- ${scope}: ${check.reason}` : `- ${scope}`;
}

function describeProbes(check: DoctorCheck): string[] {
  const probes = check.details?.probes;
  if (!Array.isArray(probes)) return [];
  const lines: string[] = [];
  for (const probe of probes) {
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) continue;
    const { name, status, evidence, guidance } = probe;
    if (
      (status !== 'failed' && status !== 'not-checked') ||
      typeof name !== 'string' ||
      typeof evidence !== 'string'
    )
      continue;
    lines.push(`  - ${name} (${status}): ${evidence}`);
    if (guidance && typeof guidance === 'object' && !Array.isArray(guidance)) {
      if (typeof guidance.action === 'string')
        lines.push(`    Fix: ${guidance.action}`);
      if (Array.isArray(guidance.yamlFields)) {
        const fields = guidance.yamlFields.filter(
          (field) => typeof field === 'string',
        );
        if (fields.length)
          lines.push(`    Configuration: ${fields.join(', ')}`);
      }
    }
  }
  return lines;
}
