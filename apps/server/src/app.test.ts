import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

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
});
