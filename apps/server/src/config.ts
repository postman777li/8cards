export interface ServerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  publicBaseUrl?: URL;
  trustedOrigins?: ReadonlySet<string>;
  staticDir?: string;
  shutdownTimeoutMs: number;
}

const integer = (name: string, value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} 必须是正整数`);
  return parsed;
};

const parseUrl = (name: string, value: string) => {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} 必须是完整 URL`);
  }
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv))
    throw new Error('NODE_ENV 只能是 development、test 或 production');

  const publicBaseUrl = env.PUBLIC_BASE_URL
    ? parseUrl('PUBLIC_BASE_URL', env.PUBLIC_BASE_URL)
    : undefined;
  if (nodeEnv === 'production') {
    if (!env.DATABASE_URL) throw new Error('生产环境必须设置 DATABASE_URL');
    const databaseUrl = parseUrl('DATABASE_URL', env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol))
      throw new Error('DATABASE_URL 必须使用 PostgreSQL');
    if (
      !['require', 'verify-ca', 'verify-full'].includes(
        databaseUrl.searchParams.get('sslmode') ?? '',
      )
    )
      throw new Error('生产环境 DATABASE_URL 必须启用 PostgreSQL TLS');
    if (!publicBaseUrl) throw new Error('生产环境必须设置 PUBLIC_BASE_URL');
    if (publicBaseUrl.protocol !== 'https:')
      throw new Error('生产环境 PUBLIC_BASE_URL 必须使用 HTTPS');
    if (
      publicBaseUrl.pathname !== '/' ||
      publicBaseUrl.search ||
      publicBaseUrl.hash
    )
      throw new Error('PUBLIC_BASE_URL 只能包含 HTTPS 源，不能包含路径或参数');
  }
  if (env.DATABASE_URL && env.EIGHTCARDS_DB)
    throw new Error('DATABASE_URL 与 EIGHTCARDS_DB 不能同时设置');

  const originValues = (env.TRUSTED_ORIGINS ?? publicBaseUrl?.origin ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const origin of originValues) {
    const url = parseUrl('TRUSTED_ORIGINS', origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
      throw new Error('TRUSTED_ORIGINS 只能包含逗号分隔的 HTTP(S) 源');
  }
  if (nodeEnv === 'production' && originValues.length === 0)
    throw new Error('生产环境必须至少配置一个可信来源');

  return {
    nodeEnv: nodeEnv as ServerConfig['nodeEnv'],
    host: env.HOST ?? '0.0.0.0',
    port: integer('PORT', env.PORT, 3001),
    shutdownTimeoutMs: integer(
      'SHUTDOWN_TIMEOUT_MS',
      env.SHUTDOWN_TIMEOUT_MS,
      25_000,
    ),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(originValues.length > 0
      ? { trustedOrigins: new Set(originValues) }
      : {}),
    ...(env.STATIC_DIR ? { staticDir: env.STATIC_DIR } : {}),
  };
}
