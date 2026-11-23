import type { JsonSchema, JsonValue } from '../contracts/index.js';
import { visitConfigStrings } from './config-fields.js';

export interface ConfigPathField {
  pointer: string;
  kind: 'file' | 'directory';
  reference: string;
  localOnly: boolean;
}

/** Enumerate declared paths against actual values, including present array items. */
export function configPathFields(
  schema: JsonSchema,
  value: JsonValue,
): ConfigPathField[] {
  const fields = new Map<string, ConfigPathField>();
  visitConfigStrings(schema, value, (pointer, reference, shape) => {
    const declaration = shape['x-rsi-path'];
    const localOnly =
      declaration === 'local-file' || declaration === 'local-directory';
    const kind = localOnly ? declaration.slice('local-'.length) : declaration;
    if (kind !== 'file' && kind !== 'directory') return;
    const previous = fields.get(pointer);
    if (previous && previous.kind !== kind)
      throw new Error(`Conflicting path declarations at ${pointer}`);
    fields.set(pointer, {
      pointer,
      kind,
      reference,
      localOnly: localOnly || previous?.localOnly === true,
    });
  });
  return [...fields.values()];
}

/** Distinguish external resource URLs from local filesystem paths. */
export function isResourceUrl(value: string): boolean {
  return (
    !/^[A-Za-z]:[\\/]/.test(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  );
}

/** Persisted digests need the same path order in every locale. */
export function compareFilePaths(
  a: { path: string },
  b: { path: string },
): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}
