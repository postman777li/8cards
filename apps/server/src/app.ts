import { createServer, type Server } from 'node:http';

import { RealtimeService, type RealtimeOptions } from './realtime.js';

export type AppServer = Server & { readonly realtime: RealtimeService };

export function createApp(options: RealtimeOptions = {}): AppServer {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    response.writeHead(404, {
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ error: 'not_found' }));
  }) as AppServer;
  const realtime = new RealtimeService(options);
  Object.defineProperty(server, 'realtime', { value: realtime });
  server.on('upgrade', (request, socket, head) =>
    realtime.handleUpgrade(request, socket, head),
  );
  return server;
}
