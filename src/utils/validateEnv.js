export const validateEnv = (definitions) => {
  const env = {};

  definitions.forEach((definition) => {
    const { key, default: defaultValue, parse, allowed } = definition;
    const rawValue = process.env[key];

    if (rawValue == null || rawValue === '') {
      if (defaultValue !== undefined) {
        env[key] = defaultValue;
        return;
      }

      throw new Error(`Missing required environment variable: ${key}`);
    }

    let value = rawValue;

    if (parse === 'int') {
      const parsed = Number.parseInt(rawValue, 10);
      if (Number.isNaN(parsed)) {
        throw new Error(`Invalid integer value for environment variable: ${key}`);
      }
      value = parsed;
    }

    if (allowed && !allowed.includes(value)) {
      throw new Error(`Invalid value for environment variable: ${key}. Allowed values: ${allowed.join(', ')}`);
    }

    env[key] = value;
  });

  return env;
};
