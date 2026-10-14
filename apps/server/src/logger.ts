const SECRET_KEY =
  /(authorization|cookie|token|secret|password|database.?url|connection.?string|private.?key)/i;
const URL_WITH_CREDENTIALS = /\b(postgres(?:ql)?:\/\/)[^\s@]+@/gi;

const sanitize = (value: unknown, key = ''): unknown => {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string')
    return value.replace(URL_WITH_CREDENTIALS, '$1[REDACTED]@');
  if (value instanceof Error)
    return {
      name: value.name,
      message: sanitize(value.message),
      ...(process.env.NODE_ENV !== 'production'
        ? { stack: sanitize(value.stack) }
        : {}),
    };
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([itemKey, item]) => [
        itemKey,
        sanitize(item, itemKey),
      ]),
    );
  return value;
};

export function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(sanitize(fields) as Record<string, unknown>),
  });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}
