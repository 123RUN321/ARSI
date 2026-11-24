import type { JsonValue } from '../contracts/json.js';
import { OperationRejectedError } from '../contracts/runtime/errors.js';

/** Error boundaries keep diagnostics without persisting configured credentials. */
export function errorText(error: unknown): string {
  const visiting = new Set<Error>();
  const describe = (value: unknown): string => {
    if (!(value instanceof Error)) return String(value);
    if (visiting.has(value)) return '[circular error]';
    visiting.add(value);
    const parts = [value.message];
    if (value instanceof AggregateError)
      for (const nested of value.errors) parts.push(describe(nested));
    if (value instanceof SuppressedError)
      parts.push(describe(value.suppressed), describe(value.error));
    if (value.cause !== undefined)
      parts.push(`cause: ${describe(value.cause)}`);
    visiting.delete(value);
    return parts.filter(Boolean).join('; ') || value.name;
  };
  let message = describe(error);
  for (const [key, value] of Object.entries(process.env))
    if (value && /(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)$/i.test(key))
      message = message.replaceAll(value, '[REDACTED]');
  return message;
}

export function redactConfiguration(
  value?: JsonValue,
): (message: string) => string {
  const secrets = new Set<string>();
  for (const [name, secret] of Object.entries(process.env))
    if (/key|token|secret|password|authorization/i.test(name) && secret)
      secrets.add(secret);
  const visit = (entry: JsonValue | undefined): void => {
    if (Array.isArray(entry)) entry.forEach(visit);
    else if (entry && typeof entry === 'object')
      for (const [key, child] of Object.entries(entry)) {
        if (
          /key|token|secret|password|authorization/i.test(key) &&
          typeof child === 'string'
        ) {
          secrets.add(child);
          for (const match of child.matchAll(
            /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          )) {
            const secret = process.env[match[1]];
            if (secret) secrets.add(secret);
          }
        } else visit(child);
      }
  };
  visit(value);
  const secretsByLength = [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return (message) => {
    for (const secret of secretsByLength)
      message = message.replaceAll(secret, '[redacted]');
    return message.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
  };
}

export class RuntimeCleanupInterruptedError extends Error {
  constructor(
    readonly interruption: unknown,
    cleanupError: unknown,
  ) {
    super('Runtime cleanup failed during interruption', {
      cause: cleanupError,
    });
  }
}

/** The candidate did not start. Expose this to the caller only after confirming cleanup. */
export class InferenceStartupError extends OperationRejectedError {
  override readonly name = 'InferenceStartupError';

  constructor(reason: string) {
    super(
      errorText(reason)
        .replace(/\p{Cc}/gu, ' ')
        .trim()
        .slice(0, 1024) || 'Inference service did not become ready',
    );
  }
}
