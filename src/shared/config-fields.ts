import Ajv from 'ajv';
import type { JsonObject, JsonSchema, JsonValue } from '../contracts/index.js';
import { object } from './json.js';

const matchers = new WeakMap<object, InstanceType<typeof Ajv.default>>();
const rootKey = 'urn:rsi:config-fields';
const escapePointer = (key: string): string =>
  key.replaceAll('~', '~0').replaceAll('/', '~1');

/** Visit string values and their applicable Schema declarations. */
export function visitConfigStrings(
  schema: JsonSchema,
  value: JsonValue,
  visit: (pointer: string, value: string, schema: JsonObject) => void,
): void {
  const root = typeof schema === 'boolean' ? {} : schema;
  const walk = (
    shape: JsonSchema,
    current: JsonValue,
    pointer: string,
    depth: number,
    schemaPointer: string,
  ): void => {
    if (depth > 32)
      throw new Error('Configuration Schema nesting exceeds 32 levels');
    if (typeof shape === 'boolean') return;
    if (typeof shape.$ref === 'string') {
      if (!shape.$ref.startsWith('#/'))
        throw new Error(
          'Configuration field declarations require resolved or local Schema references',
        );
      let referenced: JsonValue = root;
      for (const segment of shape.$ref.slice(2).split('/')) {
        referenced =
          object(referenced)[
            segment.replaceAll('~1', '/').replaceAll('~0', '~')
          ]!;
      }
      walk(
        typeof referenced === 'boolean' ? referenced : object(referenced),
        current,
        pointer,
        depth + 1,
        shape.$ref.slice(1),
      );
    }
    if (typeof current === 'string') visit(pointer, current, shape);
    if (
      Array.isArray(current) &&
      shape.items !== undefined &&
      !Array.isArray(shape.items)
    ) {
      const items =
        typeof shape.items === 'boolean' ? shape.items : object(shape.items);
      current.forEach((item, index) =>
        walk(
          items,
          item,
          `${pointer}/${index}`,
          depth + 1,
          `${schemaPointer}/items`,
        ),
      );
    } else if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      for (const [key, child] of Object.entries(
        object(shape.properties ?? {}),
      )) {
        if (Object.hasOwn(current, key))
          walk(
            typeof child === 'boolean' ? child : object(child),
            current[key],
            `${pointer}/${escapePointer(key)}`,
            depth + 1,
            `${schemaPointer}/properties/${escapePointer(key)}`,
          );
      }
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      const branches = shape[keyword];
      if (!Array.isArray(branches)) continue;
      for (const [index, raw] of branches.entries()) {
        const branch = typeof raw === 'boolean' ? raw : object(raw);
        const branchPointer = `${schemaPointer}/${keyword}/${index}`;
        let matches = true;
        if (keyword !== 'allOf') {
          let matcher = matchers.get(root);
          if (!matcher) {
            matcher = new Ajv.default({ strict: false });
            matcher.addSchema(root, rootKey);
            matchers.set(root, matcher);
          }
          const check = matcher.getSchema(`${rootKey}#${branchPointer}`);
          if (!check) throw new Error(`Missing Schema branch ${branchPointer}`);
          matches = check(current) === true;
        }
        if (matches) walk(branch, current, pointer, depth + 1, branchPointer);
      }
    }
  };
  walk(schema, value, '', 0, '');
}
