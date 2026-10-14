import { resolve } from 'node:path';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createHistoryStore } from './history-store.js';
import { log } from './logger.js';

async function main() {
  const config = loadConfig();
  const historyStore = await createHistoryStore();
  const staticDir =
    config.staticDir ??
    (config.nodeEnv === 'production' ? resolve('apps/web/dist') : undefined);
  const app = createApp({
    historyStore,
    ...(config.trustedOrigins ? { trustedOrigins: config.trustedOrigins } : {}),
    ...(staticDir ? { staticDir } : {}),
    readiness: () => historyStore.ping(),
  });

  let stopping = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutdown_started', { signal });
    const deadline = setTimeout(() => {
      log('error', 'shutdown_timeout', {
        timeoutMs: config.shutdownTimeoutMs,
      });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    deadline.unref();
    try {
      await Promise.all([
        new Promise<void>((resolveClose, reject) =>
          app.close((error) => (error ? reject(error) : resolveClose())),
        ),
        app.realtime.close(),
      ]);
      clearTimeout(deadline);
      log('info', 'shutdown_complete', { signal });
      process.exitCode = exitCode;
    } catch (error) {
      clearTimeout(deadline);
      log('error', 'shutdown_failed', { error });
      process.exitCode = 1;
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('uncaughtException', (error) => {
    log('error', 'uncaught_exception', { error });
    void shutdown('uncaughtException', 1);
  });
  process.once('unhandledRejection', (error) => {
    log('error', 'unhandled_rejection', { error });
    void shutdown('unhandledRejection', 1);
  });

  app.listen(config.port, config.host, () => {
    log('info', 'server_started', {
      host: config.host,
      port: config.port,
      database: process.env.DATABASE_URL ? 'postgresql' : 'sqlite',
      publicOrigin: config.publicBaseUrl?.origin,
    });
  });
}

main().catch((error) => {
  log('error', 'startup_failed', { error });
  process.exitCode = 1;
});
