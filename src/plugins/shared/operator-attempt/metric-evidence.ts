import type { JsonObject, JsonValue } from '../../../contracts/index.js';

const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const escapeSegment = (key: string): string =>
  key.replaceAll('~', '~0').replaceAll('/', '~1');

export const isObservedMetricPath = (path: string): boolean =>
  /^\/kernels\/\d+\/metrics\/[^/]+\//.test(path) &&
  !/(?:ub_ratio|core_utilization)/.test(path);

/** Show the model a measured citation, including when a recipe supplies its own prompt. */
export function metricEvidenceGuide(profile: JsonObject): JsonObject {
  const guidance =
    'Resolve every evidence path against this profile. Keep the actual kernel index, block ID and metric key. ' +
    'End at the numeric field without a trailing slash. Escape ~ as ~0 and / as ~1 within keys. ' +
    'Before submitting, look up each pointer and copy its exact number. Use the profile if a template differs. ' +
    'The example illustrates the citation format; choose evidence relevant to your own diagnosis.';
  if (Array.isArray(profile.kernels)) {
    for (const [index, kernel] of profile.kernels.entries()) {
      if (!isRecord(kernel) || !isRecord(kernel.metrics)) continue;
      for (const [block, metrics] of Object.entries(kernel.metrics)) {
        if (!isRecord(metrics)) continue;
        for (const [metric, value] of Object.entries(metrics)) {
          const path = `/kernels/${index}/metrics/${escapeSegment(block)}/${escapeSegment(metric)}`;
          if (
            metric &&
            typeof value === 'number' &&
            Number.isFinite(value) &&
            isObservedMetricPath(path)
          )
            return { guidance, example: { path, value } };
        }
      }
    }
  }
  return { guidance };
}
