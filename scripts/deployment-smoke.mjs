/* global URL, clearTimeout, console, fetch, process, setTimeout */

import WebSocket from 'ws';

const rawBaseUrl = process.env.DEPLOY_BASE_URL;
if (!rawBaseUrl) throw new Error('DEPLOY_BASE_URL is required');
const baseUrl = new URL(rawBaseUrl);
if (baseUrl.protocol !== 'https:' && process.env.ALLOW_HTTP_SMOKE !== 'true')
  throw new Error('DEPLOY_BASE_URL must use HTTPS');

for (const [path, expected] of [
  ['/health', 'ok'],
  ['/ready', 'ready'],
]) {
  const response = await fetch(new URL(path, baseUrl));
  const body = await response.json();
  if (!response.ok || body.status !== expected)
    throw new Error(`${path} failed with HTTP ${response.status}`);
}

const page = await fetch(baseUrl);
if (!page.ok || !(await page.text()).includes('永城八张'))
  throw new Error(`frontend failed with HTTP ${page.status}`);

const wsUrl = new URL('/ws', baseUrl);
wsUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
await new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl, { origin: baseUrl.origin });
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error('WebSocket connection timed out'));
  }, 10_000);
  socket.addEventListener('open', () => socket.close(1000, 'smoke complete'));
  socket.addEventListener('close', () => {
    clearTimeout(timeout);
    resolve();
  });
  socket.addEventListener('error', () => {
    clearTimeout(timeout);
    reject(new Error('WebSocket connection failed'));
  });
});

console.log('HTTPS, readiness, frontend, and WebSocket smoke checks passed.');
