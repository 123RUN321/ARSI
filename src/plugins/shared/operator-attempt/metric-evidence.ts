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

const summaryMetrics = [
  'aic_time(us)',
  'aic_cube_ratio',
  'aiv_time(us)',
  'aiv_vec_ratio',
  'aiv_scalar_ratio',
  'aiv_mte2_ratio',
  'aiv_mte3_ratio',
  'aiv_vec_wait_ratio',
  'aiv_mte2_wait_ratio',
  'aiv_mte2_instructions',
  'read_main_memory_datas(KB)',
  'write_main_memory_datas(KB)',
] as const;

function measuredRows(kernel: JsonObject): Array<[string, JsonObject]> {
  return Object.entries(isRecord(kernel.metrics) ? kernel.metrics : {}).flatMap(
    ([key, value]) => (isRecord(value) ? [[key, value]] : []),
  );
}

function kernels(profile: JsonObject): JsonObject[] {
  return Array.isArray(profile.kernels) ? profile.kernels.filter(isRecord) : [];
}

function distribution(rows: Array<[string, JsonObject]>): JsonObject {
  const metrics: JsonObject = {};
  for (const key of summaryMetrics) {
    const values = rows
      .map(([, row]) => row[key])
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      )
      .sort((a, b) => a - b);
    if (values.length > 0)
      metrics[key] = {
        samples: values.length,
        p50: values[Math.ceil(values.length * 0.5) - 1]!,
        p90: values[Math.ceil(values.length * 0.9) - 1]!,
      };
  }
  return {
    blockCount: new Set(rows.map(([key]) => key.split('|')[0])).size,
    rowCount: rows.length,
    metrics,
  };
}

function groupMetricRows(
  rows: Array<[string, JsonObject]>,
): Map<string, Array<[string, JsonObject]>> {
  const bySubBlock = new Map<string, Array<[string, JsonObject]>>();
  for (const row of rows) {
    const separator = row[0].indexOf('|');
    const group =
      separator < 0 ? 'block' : `sub-block:${row[0].slice(separator + 1)}`;
    const members = bySubBlock.get(group) ?? [];
    members.push(row);
    bySubBlock.set(group, members);
  }
  return bySubBlock;
}

function observedDistributions(
  rows: Array<[string, JsonObject]>,
  groups = groupMetricRows(rows),
): JsonObject {
  return {
    rowCount: rows.length,
    blockCount: new Set(rows.map(([key]) => key.split('|')[0])).size,
    groups: Object.fromEntries(
      [...groups].map(([group, members]) => [group, distribution(members)]),
    ),
  };
}

export function projectMetricProfile(profile: JsonObject): JsonObject {
  return {
    status: profile.status ?? null,
    metadata: profile.metadata ?? null,
    kernels: kernels(profile).map((kernel) => {
      const rows = measuredRows(kernel);
      const metadata = isRecord(kernel.metadata) ? kernel.metadata : {};
      const { l2CacheAnalysis: _l2, ...captureMetadata } = metadata;
      const representatives = new Map(rows.length <= 6 ? rows : []);
      const groups = groupMetricRows(rows);
      if (rows.length > 6)
        for (const members of groups.values()) {
          representatives.set(...members[0]!);
          for (const key of ['aic_time(us)', 'aiv_time(us)']) {
            const byTime = members
              .flatMap(([id, row]) =>
                typeof row[key] === 'number'
                  ? [{ id, row, time: row[key] }]
                  : [],
              )
              .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
            for (const item of [
              byTime[0],
              byTime[Math.ceil(byTime.length / 2) - 1],
              byTime.at(-1),
            ]) {
              if (item) representatives.set(item.id, item.row);
            }
          }
        }
      return {
        name: kernel.name ?? null,
        metadata: captureMetadata,
        observed: observedDistributions(rows, groups),
        metrics: Object.fromEntries(representatives),
      };
    }),
  };
}

export function candidateMetricFeedback(
  incumbent: JsonObject,
  candidate: JsonObject,
): JsonObject {
  if (candidate.status !== 'completed')
    return { status: 'unavailable', error: candidate.error ?? null };
  const summarize = (profile: JsonObject): JsonObject[] =>
    kernels(profile).map((kernel) => ({
      name: kernel.name ?? null,
      ...observedDistributions(measuredRows(kernel)),
    }));
  return {
    status: 'completed',
    incumbent: summarize(incumbent),
    candidate: summarize(candidate),
  };
}
