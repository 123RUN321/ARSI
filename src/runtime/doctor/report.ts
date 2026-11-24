import { stripVTControlCharacters } from 'node:util';
import type {
  DoctorBinding,
  DoctorCheck,
  DoctorReport,
  DoctorResult,
  JsonValue,
} from '../../contracts/index.js';
import { errorText, redactConfiguration } from '../../shared/errors.js';
import { object } from '../../shared/json.js';

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

export function appendBindingResult(
  report: DoctorReport,
  binding: DoctorBinding,
  result: DoctorResult,
): void {
  const ids = new Set(report.checks.map((check) => check.id));
  const checks = result.checks.map((check) => {
    if (check.details !== undefined) object(check.details, 'Doctor details');
    const id = `${binding.name}.${check.id}`;
    if (ids.has(id)) throw new Error(`Duplicate doctor check ID: ${id}`);
    ids.add(id);
    return {
      ...structuredClone(check),
      id,
      binding: binding.name,
      pluginId: binding.pluginId,
    };
  });
  report.checks.push(...checks);
}

export function redactDoctorReport(
  report: DoctorReport,
  redact: (message: string) => string,
): DoctorReport {
  const ids = new Set<string>();
  const checks = report.checks.map(({ reason, details, ...metadata }) => {
    if (ids.has(metadata.id))
      throw new Error(`Duplicate doctor check ID: ${metadata.id}`);
    ids.add(metadata.id);
    return {
      ...metadata,
      ...(reason ? { reason: redact(reason) } : {}),
      ...(details ? { details: object(redactJson(details, redact)) } : {}),
    };
  });
  return { recipeId: report.recipeId, checks };
}

function redactJson(
  value: JsonValue,
  redact: (message: string) => string,
): JsonValue {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value))
    return value.map((child) => redactJson(child, redact));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        redactJson(child, redact),
      ]),
    );
  return value;
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
