const ENVIRONMENT_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function expandGymEnvironment(
  value: string,
  field: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(ENVIRONMENT_REFERENCE, (_match, name: string) => {
    const replacement = environment[name];
    if (replacement === undefined)
      throw new Error(
        `gym ${field} references missing environment variable ${name}`,
      );
    return replacement;
  });
}
