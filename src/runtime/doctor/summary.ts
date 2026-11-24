import { stripVTControlCharacters } from 'node:util';
import type { DoctorCheck, DoctorReport } from '../../contracts/index.js';
import { redactConfiguration } from '../../shared/errors.js';

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
