import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createApp } from './app.js';

const servers = new Set<ReturnType<typeof createApp>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

describe('health endpoint', () => {
  it('reports that the server is available', async () => {
    const server = createApp();
    servers.add(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('服务器未绑定到 TCP 端口');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('reports database readiness without leaking an error', async () => {
    const server = createApp({
      readiness: async () => {
        throw new Error('postgresql://user:secret@example.test/db');
      },
    });
    servers.add(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: 'unavailable' });
  });

  it('serves the production frontend and SPA routes with security headers', async () => {
    const directory = mkdtempSync(join(tmpdir(), '8cards-static-'));
    writeFileSync(join(directory, 'index.html'), '<h1>8Cards</h1>');
    const server = createApp({ staticDir: directory });
    servers.add(server);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('no address');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/room/ABC123`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('8Cards');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an untrusted WebSocket origin before upgrading', async () => {
    const server = createApp({
      trustedOrigins: new Set(['https://cards.example']),
    });
    servers.add(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: 'https://evil.example',
    });
    const [error] = (await once(socket, 'error')) as [Error];
    expect(error.message).toContain('403');
  });
});
