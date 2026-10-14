import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { RealtimeService, type RealtimeOptions } from './realtime.js';

export type AppServer = Server & { readonly realtime: RealtimeService };

export interface AppOptions extends RealtimeOptions {
  staticDir?: string;
  readiness?: () => Promise<void>;
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const securityHeaders = {
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    ...securityHeaders,
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
};

const serveStatic = (
  staticDir: string,
  requestPath: string,
  response: ServerResponse,
) => {
  const root = resolve(staticDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return false;
  }
  const candidate = resolve(root, `.${normalize(decoded)}`);
  const requested =
    candidate.startsWith(`${root}\\`) || candidate.startsWith(`${root}/`)
      ? candidate
      : root;
  const file =
    existsSync(requested) && statSync(requested).isFile()
      ? requested
      : join(root, 'index.html');
  if (!existsSync(file)) return false;
  response.writeHead(200, {
    ...securityHeaders,
    'cache-control':
      extname(file) === '.html'
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(response);
  return true;
};

export function createApp(options: AppOptions = {}): AppServer {
  const { staticDir, readiness, ...realtimeOptions } = options;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && request.url === '/ready') {
      void (readiness?.() ?? Promise.resolve())
        .then(() => json(response, 200, { status: 'ready' }))
        .catch(() => json(response, 503, { status: 'unavailable' }));
      return;
    }
    if (request.method === 'GET' && staticDir) {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (serveStatic(staticDir, path, response)) return;
    }

    json(response, 404, { error: 'not_found' });
  }) as AppServer;
  const realtime = new RealtimeService(realtimeOptions);
  Object.defineProperty(server, 'realtime', { value: realtime });
  server.on('upgrade', (request, socket, head) =>
    realtime.handleUpgrade(request, socket, head),
  );
  return server;
}
