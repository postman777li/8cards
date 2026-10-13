import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createApp, type AppServer } from './app.js';

interface ReceivedEvent {
  type: string;
  [key: string]: unknown;
}

class TestClient {
  readonly socket: WebSocket;
  readonly raw: string[] = [];
  readonly events: ReceivedEvent[] = [];
  #waiters: Array<() => void> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const text = data.toString();
      this.raw.push(text);
      this.events.push(JSON.parse(text) as ReceivedEvent);
      for (const waiter of this.#waiters.splice(0)) waiter();
    });
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    return new TestClient(socket);
  }

  send(value: unknown) {
    this.socket.send(JSON.stringify(value));
  }

  async waitFor(predicate: (event: ReceivedEvent) => boolean) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = this.events.find(predicate);
      if (found) return found;
      await Promise.race([
        new Promise<void>((resolve) => this.#waiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
    throw new Error('timed out waiting for WebSocket event');
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    this.socket.close();
    await closed;
  }
}

const servers = new Set<AppServer>();
const clients = new Set<TestClient>();

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
  await Promise.all(
    [...servers].map(async (server) => {
      await server.realtime.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }),
  );
  servers.clear();
});

const start = async () => {
  const server = createApp();
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };
};

const connect = async (url: string) => {
  const client = await TestClient.connect(url);
  clients.add(client);
  return client;
};

const meta = (requestId: string, actionSequence: number) => ({
  protocolVersion: 1,
  requestId,
  actionSequence,
});

const request = async (client: TestClient, event: Record<string, unknown>) => {
  client.send(event);
  const requestId = event.requestId;
  return client.waitFor(
    (message) =>
      message.requestId === requestId &&
      (message.type === 'response.ok' || message.type === 'response.error'),
  );
};

const setupGame = async (count: 2 | 3 | 4, wsUrl: string) => {
  const all = [await connect(wsUrl)];
  const config = {
    playerCount: count,
    allowSpectators: true,
    allowChat: true,
    turnTimeoutSeconds: 20,
  };
  await request(all[0]!, {
    type: 'room.create',
    ...meta('create', 1),
    nickname: 'P0',
    roomName: '联机测试',
    config,
  });
  const hostCredential = await all[0]!.waitFor(
    (event) => event.type === 'session.established',
  );
  const hostState = await all[0]!.waitFor(
    (event) => event.type === 'state.player',
  );
  const code = (
    (hostState.view as Record<string, unknown>).public as Record<
      string,
      unknown
    >
  ).room as { code: string };
  for (let index = 1; index < count; index += 1) {
    const client = await connect(wsUrl);
    all.push(client);
    await request(client, {
      type: 'room.join',
      ...meta(`join-${index}`, 1),
      nickname: `P${index}`,
      roomCode: code.code,
    });
  }
  let version = count - 1;
  for (let index = 1; index < count; index += 1) {
    await request(all[index]!, {
      type: 'room.ready',
      ...meta(`ready-${index}`, 2),
      expectedStateVersion: version++,
      ready: true,
    });
  }
  const startResponse = await request(all[0]!, {
    type: 'room.start',
    ...meta('start', 2),
    expectedStateVersion: version,
  });
  const startedVersion = startResponse.stateVersion as number;
  const credentials = await Promise.all(
    all.map((client) =>
      client.waitFor((event) => event.type === 'session.established'),
    ),
  );
  return { all, credentials, hostCredential, startedVersion };
};

describe('HTTP and WebSocket transport', () => {
  it('serves health and rejects the wrong upgrade path', async () => {
    const { httpUrl } = await start();
    const health = await fetch(`${httpUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });

    const wrong = new WebSocket(httpUrl.replace('http:', 'ws:') + '/wrong');
    const [error] = (await once(wrong, 'error')) as [Error];
    expect(error.message).toContain('Unexpected server response: 404');
  });

  it('rejects malformed JSON, unknown fields, and binary data without crashing', async () => {
    const { wsUrl, httpUrl } = await start();
    const client = await connect(wsUrl);
    client.socket.send('{bad');
    await client.waitFor((event) => event.type === 'response.error');
    client.send({
      type: 'room.join',
      ...meta('bad-schema', 1),
      nickname: 'x',
      roomCode: 'ABC123',
      unknown: true,
    });
    await client.waitFor((event) => event.requestId === 'bad-schema');
    const binary = await connect(wsUrl);
    binary.socket.send(Buffer.from([1, 2, 3]));
    const [code] = (await once(binary.socket, 'close')) as [number];
    expect(code).toBe(1003);
    expect((await fetch(`${httpUrl}/health`)).status).toBe(200);
  });
});

describe('real multi-client games', () => {
  it.each([2, 3, 4] as const)(
    'starts a %i-player game with isolated hands and correct roles',
    async (count) => {
      const { wsUrl } = await start();
      const { all, credentials, startedVersion } = await setupGame(
        count,
        wsUrl,
      );
      expect(new Set(credentials.map((item) => item.reconnectToken)).size).toBe(
        count,
      );
      const views = await Promise.all(
        all.map((client) =>
          client.waitFor(
            (event) =>
              event.type === 'state.player' &&
              event.stateVersion === startedVersion,
          ),
        ),
      );
      const privateHands = views.map(
        (event) =>
          (
            (event.view as Record<string, unknown>).private as {
              hand: unknown[];
            }
          ).hand,
      );
      expect(privateHands.every((hand) => hand.length === 8)).toBe(true);
      expect(
        new Set(
          privateHands.flatMap((hand) =>
            hand.map((card) => JSON.stringify(card)),
          ),
        ).size,
      ).toBe(count * 8);
      for (const [index, client] of all.entries()) {
        const otherCardIds = privateHands
          .filter((_, owner) => owner !== index)
          .flatMap((hand) => hand.map((card) => (card as { id: string }).id));
        const ownCredential = credentials[index]!.reconnectToken as string;
        const messagesAfterCredential = client.raw.filter(
          (raw) => !raw.includes(ownCredential),
        );
        expect(messagesAfterCredential.join(' ')).not.toContain('tokenDigest');
        for (const id of otherCardIds)
          expect(messagesAfterCredential.join(' ')).not.toContain(`"${id}"`);
      }
      if (count === 4) {
        const game = (
          (views[0]!.view as Record<string, unknown>).public as Record<
            string,
            unknown
          >
        ).game as { players: Array<{ role: string; team: string }> };
        expect(
          game.players.filter((player) => player.role === 'observer'),
        ).toHaveLength(1);
        expect(game.players.map((player) => player.team).sort()).toEqual([
          'team-a',
          'team-a',
          'team-b',
          'team-b',
        ]);
      }
    },
  );

  it('settles a two-player round and protects ordering, idempotency, and state versions', async () => {
    const { wsUrl } = await start();
    const { all, startedVersion } = await setupGame(2, wsUrl);
    const [host, guest] = all as [TestClient, TestClient];
    const current = await host.waitFor(
      (event) =>
        event.type === 'state.player' && event.stateVersion === startedVersion,
    );
    const publicGame = (
      (current.view as Record<string, unknown>).public as Record<
        string,
        unknown
      >
    ).game as { currentActorId: string };
    const actorClient = (
      await Promise.all(
        all.map(async (client) => ({
          client,
          credential: await client.waitFor(
            (event) => event.type === 'session.established',
          ),
        })),
      )
    ).find(
      (item) => item.credential.playerId === publicGame.currentActorId,
    )!.client;
    const actorState = await actorClient.waitFor(
      (event) =>
        event.type === 'state.player' && event.stateVersion === startedVersion,
    );
    const hand = (
      (actorState.view as Record<string, unknown>).private as {
        hand: Array<{ id: string; kind: string }>;
      }
    ).hand;
    const attackCard = hand.find((card) => card.kind === 'standard')!;
    const actorSequence = actorClient === host ? 3 : 3;
    const defenderClient = actorClient === host ? guest : host;
    const forged = await request(defenderClient, {
      type: 'game.action',
      ...meta('wrong-actor', 3),
      expectedStateVersion: startedVersion,
      action: { kind: 'play-card', cardId: attackCard.id },
    });
    expect((forged.error as { code: string }).code).toBe('WRONG_ACTOR');
    const attack = {
      type: 'game.action',
      ...meta('attack', actorSequence),
      expectedStateVersion: startedVersion,
      action: { kind: 'play-card', cardId: attackCard.id },
    };
    const first = await request(actorClient, attack);
    expect(first.type).toBe('response.ok');
    actorClient.send(attack);
    const replay = await actorClient.waitFor(
      (event) => event.type === 'response.ok' && event.requestId === 'attack',
    );
    expect(replay.stateVersion).toBe(startedVersion + 1);
    const wrongTarget = await request(defenderClient, {
      type: 'game.action',
      ...meta('wrong-target', 4),
      expectedStateVersion: startedVersion + 1,
      action: {
        kind: 'beat-card',
        cardId: attackCard.id,
        targetCardId: attackCard.id === 'clubs-A' ? 'clubs-K' : 'clubs-A',
      },
    });
    expect((wrongTarget.error as { code: string }).code).toBe('ILLEGAL_ACTION');
    const collect = await request(defenderClient, {
      type: 'game.action',
      ...meta('collect', 5),
      expectedStateVersion: startedVersion + 1,
      action: { kind: 'collect' },
    });
    expect(collect.stateVersion).toBe(startedVersion + 2);
    const settled = await host.waitFor(
      (event) =>
        event.type === 'state.player' &&
        event.stateVersion === startedVersion + 2,
    );
    const table = (
      (
        (settled.view as Record<string, unknown>).public as Record<
          string,
          unknown
        >
      ).game as { table: unknown[] }
    ).table;
    expect(table).toEqual([]);

    const stale = await request(actorClient, {
      type: 'game.action',
      ...meta('stale', 4),
      expectedStateVersion: startedVersion,
      action: { kind: 'pass' },
    });
    expect((stale.error as { code: string }).code).toBe('STALE_STATE');
    const jump = await request(actorClient, {
      type: 'game.action',
      ...meta('jump', 6),
      expectedStateVersion: startedVersion + 2,
      action: { kind: 'pass' },
    });
    expect((jump.error as { code: string }).code).toBe('DUPLICATE_REQUEST');
  });
});
