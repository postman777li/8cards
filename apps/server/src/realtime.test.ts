import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { compareCards } from '@8cards/game-engine';

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

const start = async (randomOverride?: () => number) => {
  let randomState = 0x12345678;
  const server = createApp({
    random:
      randomOverride ??
      (() => {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return (randomState >>> 0) / 0x1_0000_0000;
      }),
  });
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
  it('validates start eligibility before initialization and preserves state on every failure', async () => {
    const { wsUrl } = await start();
    const host = await connect(wsUrl);
    await request(host, {
      type: 'room.create',
      ...meta('eligibility-create', 1),
      nickname: 'host',
      roomName: '资格检查',
      config: {
        playerCount: 2,
        allowSpectators: true,
        allowChat: true,
        turnTimeoutSeconds: 20,
      },
    });
    const initial = await host.waitFor(
      (event) => event.type === 'state.player',
    );
    const roomCode = (
      (initial.view as Record<string, unknown>).public as {
        room: { code: string };
      }
    ).room.code;
    const tooFew = await request(host, {
      type: 'room.start',
      ...meta('too-few', 2),
      expectedStateVersion: 0,
    });
    expect((tooFew.error as { code: string }).code).toBe('ILLEGAL_ACTION');
    expect(
      host.events.filter((event) => event.type === 'state.player'),
    ).toHaveLength(1);

    const guest = await connect(wsUrl);
    await request(guest, {
      type: 'room.join',
      ...meta('eligibility-join', 1),
      nickname: 'guest',
      roomCode,
    });
    const nonHost = await request(guest, {
      type: 'room.start',
      ...meta('non-host-start', 2),
      expectedStateVersion: 1,
    });
    expect((nonHost.error as { code: string }).code).toBe('WRONG_ACTOR');
    const notReady = await request(host, {
      type: 'room.start',
      ...meta('not-ready-start', 3),
      expectedStateVersion: 1,
    });
    expect((notReady.error as { code: string }).code).toBe('ILLEGAL_ACTION');
    expect(
      host.events.filter(
        (event) => event.type === 'state.player' && event.stateVersion === 1,
      ),
    ).toHaveLength(1);

    await request(guest, {
      type: 'room.ready',
      ...meta('eligibility-ready', 3),
      expectedStateVersion: 1,
      ready: true,
    });
    const started = await request(host, {
      type: 'room.start',
      ...meta('eligibility-start', 4),
      expectedStateVersion: 2,
    });
    expect(started.stateVersion).toBe(3);
    const repeated = await request(host, {
      type: 'room.start',
      ...meta('repeat-start', 5),
      expectedStateVersion: 3,
    });
    expect((repeated.error as { code: string }).code).toBe('ILLEGAL_ACTION');
    expect(
      host.events.filter(
        (event) => event.type === 'state.player' && event.stateVersion === 3,
      ),
    ).toHaveLength(1);
  });

  it('leaves the room waiting when game initialization fails', async () => {
    const { wsUrl } = await start(() => 1);
    const host = await connect(wsUrl);
    const guest = await connect(wsUrl);
    await request(host, {
      type: 'room.create',
      ...meta('init-create', 1),
      nickname: 'host',
      roomName: '初始化失败',
      config: {
        playerCount: 2,
        allowSpectators: true,
        allowChat: true,
        turnTimeoutSeconds: 20,
      },
    });
    const initial = await host.waitFor(
      (event) => event.type === 'state.player',
    );
    const roomCode = (
      (initial.view as Record<string, unknown>).public as {
        room: { code: string };
      }
    ).room.code;
    await request(guest, {
      type: 'room.join',
      ...meta('init-join', 1),
      nickname: 'guest',
      roomCode,
    });
    await request(guest, {
      type: 'room.ready',
      ...meta('init-ready', 2),
      expectedStateVersion: 1,
      ready: true,
    });
    const failed = await request(host, {
      type: 'room.start',
      ...meta('init-start', 2),
      expectedStateVersion: 2,
    });
    expect((failed.error as { code: string }).code).toBe('INTERNAL_ERROR');
    const stillWaiting = await request(host, {
      type: 'room.ready',
      ...meta('init-still-waiting', 3),
      expectedStateVersion: 2,
      ready: true,
    });
    expect(stillWaiting).toMatchObject({
      type: 'response.ok',
      stateVersion: 3,
    });
  });

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

  it('advertises and accepts an empty-table pass', async () => {
    const { wsUrl } = await start();
    const { all, startedVersion } = await setupGame(2, wsUrl);
    const entries = await Promise.all(
      all.map(async (client) => ({
        client,
        state: await client.waitFor(
          (event) =>
            event.type === 'state.player' &&
            event.stateVersion === startedVersion,
        ),
      })),
    );
    const actorId = (
      (entries[0]!.state.view as Record<string, unknown>).public as {
        game: { currentActorId: string };
      }
    ).game.currentActorId;
    const actor = entries.find(
      ({ state }) =>
        (state.view as { viewerPlayerId: string }).viewerPlayerId === actorId,
    )!;
    expect(
      (
        (actor.state.view as Record<string, unknown>).private as {
          legalActionTypes: string[];
        }
      ).legalActionTypes,
    ).toContain('pass');
    const passed = await request(actor.client, {
      type: 'game.action',
      ...meta('empty-pass', 3),
      expectedStateVersion: startedVersion,
      action: { kind: 'pass' },
    });
    expect(passed).toMatchObject({
      type: 'response.ok',
      stateVersion: startedVersion + 1,
    });
  });

  it('lets the other three-player attacker follow by cursor and rejects a four-player observer', async () => {
    const { wsUrl } = await start();
    const three = await setupGame(3, wsUrl);
    const threeEntries = await Promise.all(
      three.all.map(async (client) => ({
        client,
        credential: await client.waitFor(
          (event) => event.type === 'session.established',
        ),
        state: await client.waitFor(
          (event) =>
            event.type === 'state.player' &&
            event.stateVersion === three.startedVersion,
        ),
      })),
    );
    const publicGame = (
      (threeEntries[0]!.state.view as Record<string, unknown>).public as Record<
        string,
        unknown
      >
    ).game as {
      currentActorId: string;
      defenderId: string;
      trumpSuit: 'clubs' | 'diamonds' | 'hearts' | 'spades';
      players: Array<{ playerId: string; role: string }>;
    };
    const primary = threeEntries.find(
      (entry) => entry.credential.playerId === publicGame.currentActorId,
    )!;
    const defender = threeEntries.find(
      (entry) => entry.credential.playerId === publicGame.defenderId,
    )!;
    const follower = threeEntries.find(
      (entry) =>
        entry.credential.playerId !== publicGame.currentActorId &&
        entry.credential.playerId !== publicGame.defenderId,
    )!;
    const handOf = (entry: (typeof threeEntries)[number]) =>
      (
        (entry.state.view as Record<string, unknown>).private as {
          hand: Array<{
            id: string;
            kind: 'standard' | 'joker';
            suit?: 'clubs' | 'diamonds' | 'hearts' | 'spades';
            rank: string;
          }>;
        }
      ).hand;
    const primaryHand = handOf(primary);
    const defenderHand = handOf(defender);
    const followerHand = handOf(follower);
    const combination = primaryHand
      .filter((card) => card.kind === 'standard')
      .flatMap((attack) =>
        defenderHand
          .filter(
            (defense) =>
              compareCards(
                defense as Parameters<typeof compareCards>[0],
                attack as Parameters<typeof compareCards>[1],
                publicGame.trumpSuit,
              ) === 1,
          )
          .map((defense) => ({
            attack,
            defense,
            follow: followerHand.find(
              (card) =>
                card.kind === 'standard' &&
                (card.rank === attack.rank || card.rank === defense.rank),
            ),
          })),
      )
      .find((candidate) => candidate.follow);
    expect(combination).toBeDefined();
    const attacked = await request(primary.client, {
      type: 'game.action',
      ...meta('three-attack', 3),
      expectedStateVersion: three.startedVersion,
      action: { kind: 'play-card', cardId: combination!.attack.id },
    });
    const defended = await request(defender.client, {
      type: 'game.action',
      ...meta('three-defend', 3),
      expectedStateVersion: attacked.stateVersion as number,
      action: {
        kind: 'beat-card',
        cardId: combination!.defense.id,
        targetCardId: combination!.attack.id,
      },
    });
    const followed = await request(follower.client, {
      type: 'game.action',
      ...meta('three-follow', 3),
      expectedStateVersion: defended.stateVersion as number,
      action: { kind: 'play-card', cardId: combination!.follow!.id },
    });
    expect(followed).toMatchObject({
      type: 'response.ok',
      stateVersion: three.startedVersion + 3,
    });
    const followedState = await primary.client.waitFor(
      (event) =>
        event.type === 'state.player' &&
        event.stateVersion === three.startedVersion + 3,
    );
    const table = (
      (followedState.view as Record<string, unknown>).public as {
        game: { table: Array<{ playerId: string; purpose: string }> };
      }
    ).game.table;
    expect(
      table
        .filter((play) => play.purpose === 'attack')
        .map((play) => play.playerId),
    ).toEqual([primary.credential.playerId, follower.credential.playerId]);

    const four = await setupGame(4, wsUrl);
    const fourEntries = await Promise.all(
      four.all.map(async (client) => ({
        client,
        credential: await client.waitFor(
          (event) => event.type === 'session.established',
        ),
        state: await client.waitFor(
          (event) =>
            event.type === 'state.player' &&
            event.stateVersion === four.startedVersion,
        ),
      })),
    );
    const fourPlayers = (
      (fourEntries[0]!.state.view as Record<string, unknown>).public as {
        game: { players: Array<{ playerId: string; role: string }> };
      }
    ).game.players;
    const observerId = fourPlayers.find(
      (player) => player.role === 'observer',
    )!.playerId;
    const observer = fourEntries.find(
      (entry) => entry.credential.playerId === observerId,
    )!;
    const observerCard = handOf(observer as (typeof threeEntries)[number]).find(
      (card) => card.kind === 'standard',
    )!;
    const rejected = await request(observer.client, {
      type: 'game.action',
      ...meta('observer-action', 3),
      expectedStateVersion: four.startedVersion,
      action: { kind: 'play-card', cardId: observerCard.id },
    });
    expect((rejected.error as { code: string }).code).toBe('WRONG_ACTOR');
    expect(
      observer.client.events.filter(
        (event) =>
          event.type === 'state.player' &&
          (event.stateVersion as number) > four.startedVersion,
      ),
    ).toHaveLength(0);
  });
});
