import type { JsonValue } from '../../contracts/index.js';

const secretNamePattern = /key|token|secret|password|authorization/i;

export function createDoctorRedactor(
  configuration?: JsonValue,
): (message: string) => string {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(process.env))
    if (secretNamePattern.test(name) && value) secrets.add(value);

  const collectSecrets = (value: JsonValue | undefined): void => {
    if (Array.isArray(value)) value.forEach(collectSecrets);
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (secretNamePattern.test(key) && typeof child === 'string') {
          secrets.add(child);
          for (const [, name] of child.matchAll(
            /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          )) {
            const secret = process.env[name];
            if (secret) secrets.add(secret);
          }
        } else collectSecrets(child);
      }
    }
  };
  collectSecrets(configuration);
  const secretsByLength = [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return (message) => {
    for (const secret of secretsByLength)
      message = message.replaceAll(secret, '[redacted]');
    return message.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
  };
}
