import type { JsonValue } from '../../contracts/index.js';

const secretName = /key|token|secret|password|authorization/i;

export function createDoctorRedactor(
  configuration?: JsonValue,
): (message: string) => string {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(process.env))
    if (secretName.test(name) && value) secrets.add(value);

  const collect = (value: JsonValue | undefined): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (secretName.test(key) && typeof child === 'string') {
          secrets.add(child);
          for (const [, name] of child.matchAll(
            /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          )) {
            const secret = process.env[name];
            if (secret) secrets.add(secret);
          }
        } else collect(child);
      }
    }
  };
  collect(configuration);
  const orderedSecrets = [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return (message) => {
    for (const secret of orderedSecrets)
      message = message.replaceAll(secret, '[redacted]');
    return message.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
  };
}
