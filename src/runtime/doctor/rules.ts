import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { parse, sep } from 'node:path';
import type {
  DoctorBinding,
  DoctorContext,
  DoctorResult,
  DoctorRule,
} from '../../contracts/index.js';
import { visitConfigStrings } from '../../shared/config-fields.js';
import {
  missingInputError,
  runDoctorProbe,
} from '../../shared/doctor-check.js';
import { errorText } from '../../shared/errors.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';

export async function runDoctorRules(
  rules: DoctorRule[],
  signal: AbortSignal,
): Promise<DoctorResult> {
  if (!Array.isArray(rules))
    throw new Error('Doctor must return an array of check definitions.');
  const ids = new Set<string>();
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule !== 'object' ||
      typeof rule.id !== 'string' ||
      !rule.id ||
      ids.has(rule.id)
    )
      throw new Error('Doctor check IDs must be nonempty and unique.');
    if (
      Object.keys(rule).some(
        (key) =>
          !['id', 'check', 'reason', 'details', 'timeoutMs'].includes(key),
      )
    )
      throw new Error(`Doctor ${rule.id} has an unsupported definition field.`);
    if (rule.check !== undefined && typeof rule.check !== 'function')
      throw new Error(`Doctor ${rule.id}.check must be a function.`);
    if (
      rule.timeoutMs !== undefined &&
      rule.timeoutMs !== null &&
      (!Number.isFinite(rule.timeoutMs) || rule.timeoutMs <= 0)
    )
      throw new Error(`Doctor ${rule.id}.timeoutMs must be positive.`);
    ids.add(rule.id);
  }
  const checks: DoctorResult['checks'] = [];
  let failure: string | undefined;
  for (const rule of rules) {
    signal.throwIfAborted();
    if (failure) {
      checks.push({
        id: rule.id,
        status: 'unchecked',
        reason: `Not executed because ${failure} failed. Fix that failure and rerun doctor.`,
      });
      continue;
    }
    if (typeof rule.reason !== 'string')
      throw new Error(`Doctor ${rule.id}.reason must be a string.`);
    const check = rule.check;
    if (!check) {
      checks.push({
        id: rule.id,
        status: 'unchecked',
        reason: rule.reason,
        ...(rule.details ? { details: rule.details } : {}),
      });
      continue;
    }
    const requireBoolean = (value: unknown): boolean => {
      if (typeof value !== 'boolean')
        throw new Error(`${rule.id}.check must return a boolean.`);
      return value;
    };
    const execute = (bounded: AbortSignal): boolean | Promise<boolean> => {
      const result = check(bounded);
      return typeof result === 'boolean'
        ? result
        : Promise.resolve(result).then(requireBoolean);
    };
    const result =
      rule.timeoutMs === null
        ? await Promise.resolve()
            .then(() => execute(signal))
            .then(
              (value) => ({ value, reason: undefined }),
              (error: unknown) => {
                signal.throwIfAborted();
                return { value: undefined, reason: errorText(error) };
              },
            )
        : await runDoctorProbe(rule.id, execute, {
            signal,
            timeoutMs: rule.timeoutMs,
          }).then(({ value, check }) => ({ value, reason: check.reason }));
    signal.throwIfAborted();
    if (result.value !== true) failure = rule.id;
    checks.push({
      id: rule.id,
      status: result.value === true ? 'passed' : 'failed',
      ...(result.value !== true
        ? { reason: [rule.reason, result.reason].filter(Boolean).join(' ') }
        : {}),
      ...(rule.details ? { details: rule.details } : {}),
    });
  }
  return { checks };
}

const directorySuffix = sep === '\\' ? /(?:[\\/]\.?)+$/ : /(?:\/\.?)+$/;

export function declaredPathRules(binding: DoctorBinding): DoctorRule[] {
  const rules: DoctorRule[] = [];
  for (const { pointer, kind, reference, localOnly } of configPathFields(
    binding.definition.configSchema,
    binding.config,
  )) {
    const isUrl = isResourceUrl(reference);
    if (isUrl && !localOnly) continue;
    const configField = pointer.slice(1).replaceAll('/', '.');
    const field = `${binding.name}.config.${configField}`;
    rules.push({
      id: `resource.${configField}`,
      reason: `Correct ${field} to point to a readable ${kind}.`,
      check: async () => {
        if (isUrl)
          throw new Error(
            `Set ${field} to a local ${kind} path. Current value is ${reference}.`,
          );
        let path = reference;
        if (localOnly && kind === 'directory') {
          // A trailing slash or dot can make lstat follow the final symlink.
          const { root } = parse(reference);
          path =
            root + reference.slice(root.length).replace(directorySuffix, '');
        }
        try {
          const pathInfo = await (localOnly ? lstat(path) : stat(path));
          if (pathInfo.isSymbolicLink())
            throw new Error(
              `${configField}: symbolic links are not allowed: ${reference}`,
            );
          if (!(kind === 'file' ? pathInfo.isFile() : pathInfo.isDirectory()))
            throw new Error(`${pointer}: expected ${kind}: ${reference}`);
          await access(reference, constants.R_OK);
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            throw missingInputError({ field, kind, reference }, error);
          throw new Error(`Correct ${field} to point to a readable ${kind}.`, {
            cause: error,
          });
        }
        return true;
      },
    });
  }
  return rules;
}

export function bindingReferenceRules({
  binding,
  recipe,
  signal,
}: DoctorContext): DoctorRule[] {
  signal.throwIfAborted();
  const references = new Map<
    string,
    { reference: string; contracts: Set<string> }
  >();
  visitConfigStrings(
    binding.definition.configSchema,
    binding.config,
    (pointer, reference, schema) => {
      const contract = schema['x-rsi-binding'];
      if (typeof contract !== 'string') return;
      const previous = references.get(pointer);
      if (previous) previous.contracts.add(contract);
      else
        references.set(pointer, { reference, contracts: new Set([contract]) });
    },
  );
  return [...references].map(([pointer, { reference, contracts }]) => {
    const field = pointer.slice(1).replaceAll('/', '.');
    const configField = `${binding.name}.config.${field}`;
    return {
      id: `binding.${field}`,
      reason: `Correct ${configField} to reference a binding implementing its declared contract.`,
      check: () => {
        const [contract] = contracts;
        if (contracts.size > 1)
          throw new Error(
            `${configField} has conflicting binding contracts (${[...contracts].join(', ')}). Correct the plugin Schema to declare one contract for this field.`,
          );
        if (!Object.hasOwn(recipe.bindings, reference))
          throw new Error(
            `${configField} refers to ${reference}, which is not declared. Use a declared binding implementing ${contract}.`,
          );
        const target = recipe.bindings[reference]!;
        const actual = target.definition.contract.id;
        if (actual !== contract)
          throw new Error(
            `${configField} refers to ${reference}, which implements ${actual} through ${target.pluginId}. Use a binding implementing ${contract}.`,
          );
        return true;
      },
    };
  });
}
