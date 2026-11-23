import { stripVTControlCharacters } from 'node:util';
import type { DoctorCheck, DoctorReport } from '../../contracts/index.js';

export function formatDoctorSummary(
  report: DoctorReport,
  file: string,
): string {
  const failed = report.checks.filter((check) => check.status === 'failed');
  const unchecked = report.checks.filter(
    (check) => check.status === 'unchecked',
  );
  const passed = report.checks.length - failed.length - unchecked.length;
  const result = failed.length ? 'failures' : 'no failures';
  const lines = [
    `Doctor found ${result} for ${report.recipeId ?? file}.`,
    `${passed} passed, ${failed.length} failed, ${unchecked.length} unchecked.`,
  ];

  if (failed.length) lines.push('', 'Failed checks');
  for (const check of failed) {
    lines.push(describeCheck(check));
    if (check.missingResource) {
      const { field, kind } = check.missingResource;
      lines.push(
        `  Fix: Restore the ${kind} or update ${field} to point to an available ${kind}.`,
      );
    } else if (check.id === 'recipe.validate') {
      lines.push(
        `  Fix: Check ${file} and correct the path or configuration named in the error.`,
      );
    } else if (check.id === 'runtime.registration') {
      lines.push(
        '  Fix: Check the component or extension named in the error and verify its installation.',
      );
    }
    lines.push(...describeProbes(check));
    const blocked = unchecked.filter(({ blockedBy }) => blockedBy === check.id);
    if (blocked.length)
      lines.push(`  Blocked: ${blocked.map(({ id }) => id).join(', ')}`);
  }

  const unverified = unchecked.filter((check) => !check.blockedBy);
  if (unverified.length) lines.push('', 'Unchecked checks');
  for (const check of unverified) {
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
  if (check.missingResource) {
    const { kind, reference } = check.missingResource;
    return `- ${scope}: Missing ${kind} ${reference}`;
  }
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
