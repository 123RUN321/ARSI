import { diffIndices } from 'node-diff3';
import {
  readObservation,
  parseArtifact,
  type ArtifactPreview,
} from '../../api/observation-client.js';
import { readAllObservationPages } from '../../api/read-all-pages.js';
import { QueryCache } from '../../api/query-cache.js';
import type { RecordedFile } from './file-browser-model.js';

export interface TextChange {
  path: string;
  kind: 'added' | 'removed' | 'modified' | 'unavailable';
  before: string | null;
  after: string | null;
  reason?: string;
}
export interface CandidateDiff {
  changes: TextChange[];
  unchanged: number;
  total: number;
}
// Reuse shared parent snapshots across comparisons, scoped to the experiment.
const indexes = new QueryCache<RecordedFile[]>(24);
const previews = new QueryCache<ArtifactPreview>(128);

function fileIndex(raw: unknown) {
  const value = parseArtifact(raw);
  if (value.kind !== 'file-tree' || !value.files)
    throw new Error('Text comparison requires two recorded file trees.');
  return value.files;
}
function textProblem(value: ArtifactPreview | null): string | null {
  if (value === null) return null;
  if (value.unavailable) return value.unavailable;
  if (!value.content) return 'Text was not recorded.';
  if (value.content.truncated)
    return 'Preview is truncated; a complete text comparison is unavailable.';
  if (value.content.text.includes('[REDACTED]'))
    return 'Redacted text cannot establish a complete comparison.';
  return null;
}
/** Compare immutable public text previews only. Unknown/binary/restricted files never count as unchanged. */
async function readCandidateDiff(
  id: string,
  parent: string,
  current: string,
  signal: AbortSignal,
  prefix = '',
  force = false,
): Promise<CandidateDiff> {
  const base = `/${encodeURIComponent(id)}/artifacts/`;
  const [beforeIndex, afterIndex] = await Promise.all(
    [parent, current].map((ref) =>
      indexes.read(
        base + encodeURIComponent(ref),
        async (requestSignal) =>
          (
            await readAllObservationPages(
              base + encodeURIComponent(ref),
              fileIndex,
              requestSignal,
            )
          ).items,
        signal,
        60000,
        force,
      ),
    ),
  );
  const before = new Map(
    beforeIndex!.map((file: RecordedFile) => [file.path, file]),
  );
  const after = new Map(
    afterIndex!.map((file: RecordedFile) => [file.path, file]),
  );
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => path.startsWith(prefix))
    .sort();
  if (paths.length > 128)
    throw new Error(
      'Text comparison supports up to 128 files. The complete snapshot remains available in Full files.',
    );
  const changes: (TextChange | null)[] = new Array(paths.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (cursor < paths.length) {
        signal.throwIfAborted();
        const index = cursor++,
          path = paths[index]!;
        const oldDigest = before.get(path)?.digest;
        if (oldDigest && oldDigest === after.get(path)?.digest) {
          changes[index] = null;
          continue;
        }
        const read = (ref: string) => {
          const key = `${base}${encodeURIComponent(ref)}?${new URLSearchParams({ path })}`;
          return previews.read(
            key,
            (requestSignal) =>
              readObservation(key, parseArtifact, requestSignal),
            signal,
            60000,
            force,
          );
        };
        const [left, right] = await Promise.all([
          before.has(path) ? read(parent) : null,
          after.has(path) ? read(current) : null,
        ]);
        const reason = textProblem(left) ?? textProblem(right);
        const oldText = left?.content?.text ?? null,
          newText = right?.content?.text ?? null;
        changes[index] = reason
          ? { path, kind: 'unavailable', before: null, after: null, reason }
          : !before.has(path)
            ? { path, kind: 'added', before: null, after: newText }
            : !after.has(path)
              ? { path, kind: 'removed', before: oldText, after: null }
              : oldText !== newText
                ? { path, kind: 'modified', before: oldText, after: newText }
                : null;
      }
    }),
  );
  return {
    changes: changes.filter((change): change is TextChange => change !== null),
    unchanged: changes.filter((change) => change === null).length,
    total: paths.length,
  };
}
/** Abort sibling reads on failure as well as when the view is left. */
export async function loadCandidateDiff(
  id: string,
  parent: string,
  current: string,
  signal: AbortSignal,
  prefix = '',
  force = false,
): Promise<CandidateDiff> {
  const controller = new AbortController();
  try {
    return await readCandidateDiff(
      id,
      parent,
      current,
      AbortSignal.any([signal, controller.signal]),
      prefix,
      force,
    );
  } catch (error) {
    controller.abort();
    throw error;
  }
}
export interface DiffLine {
  kind: 'context' | 'removed' | 'added';
  text: string;
  before: number | null;
  after: number | null;
}
function contentLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** Align matching lines between edits and retain three lines of context around each change. */
export function changedLines(
  before: string | null,
  after: string | null,
): DiffLine[] {
  if (before === after) return [];
  const left = contentLines(before);
  const right = contentLines(after);
  const lines: DiffLine[] = [];
  let previousEnd = 0;
  const changes = diffIndices(left, right);
  for (const [index, change] of changes.entries()) {
    const {
      buffer1: [start, removed],
      buffer2: [next, added],
    } = change;
    for (let i = Math.max(previousEnd, start - 3); i < start; i++)
      lines.push({
        kind: 'context',
        text: left[i]!,
        before: i + 1,
        after: next - start + i + 1,
      });
    for (let i = start; i < start + removed; i++)
      lines.push({
        kind: 'removed',
        text: left[i]!,
        before: i + 1,
        after: null,
      });
    for (let i = next; i < next + added; i++)
      lines.push({
        kind: 'added',
        text: right[i]!,
        before: null,
        after: i + 1,
      });
    previousEnd = start + removed;
    // Only emit trailing context up to the next edit, where line offsets can change.
    const gap = Math.min(
      3,
      (changes[index + 1]?.buffer1[0] ?? left.length) - previousEnd,
    );
    for (let i = 0; i < gap; i++) {
      lines.push({
        kind: 'context',
        text: left[previousEnd]!,
        before: previousEnd + 1,
        after: next + added + i + 1,
      });
      previousEnd++;
    }
  }
  return lines;
}
