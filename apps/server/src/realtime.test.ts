import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { compareCards } from '@8cards/game-engine';
import type { Card } from '@8cards/shared';

import { createApp, type AppServer } from './app.js';
import {
  SqliteHistoryStore,
  type HistoryStore,
  type PersistedGame,
} from './history-store.js';

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

const start = async (
  randomOverride?: () => number,
  historyStore?: HistoryStore,
) => {
  let randomState = 0x12345678;
  const server = createApp({
    presentationEnabled: false,
    random:
      randomOverride ??
      (() => {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return (randomState >>> 0) / 0x1_0000_0000;
      }),
    ...(historyStore ? { historyStore } : {}),
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
    visitorId: 'visitor-p0',
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
      visitorId: `visitor-p${index}`,
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

class FailOnceHistoryStore implements HistoryStore {
  readonly inner = new SqliteHistoryStore(':memory:');
  attempts = 0;
  async saveGame(game: PersistedGame) {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error('injected write failure');
    return this.inner.saveGame(game);
  }
  getVisitorHistory(
    visitorId: Parameters<HistoryStore['getVisitorHistory']>[0],
    limit?: number,
  ) {
    return this.inner.getVisitorHistory(visitorId, limit);
  }
  ping() {
    return this.inner.ping();
  }
  close() {
    return this.inner.close();
  }
}

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
    'completes a %i-player game over real WebSockets and persists its result',
    async (count) => {
      const historyStore = new SqliteHistoryStore(':memory:');
      const { wsUrl } = await start(undefined, historyStore);
      const game = await setupGame(count, wsUrl);
      const entries = await Promise.all(
        game.all.map(async (client) => ({
          client,
          credential: await client.waitFor(
            (event) => event.type === 'session.established',
          ),
        })),
      );
      const sequences = new Map(game.all.map((client) => [client, 3]));
      let version = game.startedVersion;
      let finished: ReceivedEvent | undefined;
      for (let step = 0; step < 300 && !finished; step += 1) {
        const state = await game.all[0]!.waitFor(
          (event) =>
            event.type === 'state.player' && event.stateVersion === version,
        );
        const publicGame = (
          state.view as {
            public: {
              game: {
                phase: string;
                currentActorId: string | null;
                trumpSuit: 'clubs' | 'diamonds' | 'hearts' | 'spades';
                table: Array<{ card: Card; purpose: 'attack' | 'defense' }>;
              };
            };
          }
        ).public.game;
        if (publicGame.phase === 'finished') {
          finished = state;
          break;
        }
        const actor = entries.find(
          (entry) => entry.credential.playerId === publicGame.currentActorId,
        );
        if (!actor) throw new Error('current actor has no WebSocket client');
        const actorState = await actor.client.waitFor(
          (event) =>
            event.type === 'state.player' && event.stateVersion === version,
        );
        const privateState = (
          actorState.view as {
            private: {
              hand: Card[];
              legalActionTypes: string[];
            };
          }
        ).private;
        const sequence = sequences.get(actor.client)!;
        sequences.set(actor.client, sequence + 1);
        const target = [...publicGame.table]
          .reverse()
          .find((play) => play.purpose === 'attack')?.card;
        const defense = target
          ? privateState.hand.find(
              (card) =>
                compareCards(card, target, publicGame.trumpSuit) === 1 ||
                (card.kind === 'joker' && target.kind !== 'joker'),
            )
          : undefined;
        const action =
          privateState.legalActionTypes.includes('beat-card') &&
          defense &&
          target
            ? { kind: 'beat-card', cardId: defense.id, targetCardId: target.id }
            : privateState.legalActionTypes.includes('collect')
              ? { kind: 'collect' }
              : privateState.legalActionTypes.includes('pass') &&
                  publicGame.table.length > 0
                ? { kind: 'pass' }
                : privateState.legalActionTypes.includes('play-card')
                  ? {
                      kind: 'play-card',
                      cardId: privateState.hand.find(
                        (card) => card.kind === 'standard',
                      )!.id,
                    }
                  : { kind: 'pass' };
        const response = await request(actor.client, {
          type: 'game.action',
          ...meta(`complete-${count}-${step}`, sequence),
          expectedStateVersion: version,
          action,
        });
        expect(response.type).toBe('response.ok');
        version = response.stateVersion as number;
      }
      expect(finished).toBeDefined();
      const result = (
        finished!.view as {
          public: {
            game: {
              phase: string;
              resultReason?: string;
              winnerPlayerIds?: string[];
              loserPlayerIds?: string[];
            };
          };
        }
      ).public.game;
      expect(result.phase).toBe('finished');
      expect(['emptied-hand', 'stuck-with-jokers']).toContain(
        result.resultReason,
      );
      expect(
        (result.winnerPlayerIds?.length ?? 0) +
          (result.loserPlayerIds?.length ?? 0),
      ).toBeGreaterThan(0);
      const series = (
        finished!.view as {
          public: {
            series: {
              phase: string;
              finishOrder: string[];
              participants: Array<{ playerId: string; score: number }>;
            };
          };
        }
      ).public.series;
      expect(series.phase).toBe('continue-vote');
      expect(series.participants).toHaveLength(count);
      expect(series.finishOrder).toHaveLength(count);
      expect(new Set(series.finishOrder).size).toBe(count);
      expect(
        series.finishOrder.every((playerId) =>
          series.participants.some((item) => item.playerId === playerId),
        ),
      ).toBe(true);
      expect(
        series.participants.reduce((sum, item) => sum + item.score, 0),
      ).toBe(0);
      if (count < 4) {
        expect(
          series.participants.map((item) => item.score).sort((a, b) => a - b),
        ).toEqual(count === 2 ? [-1, 1] : [-1, 0, 1]);
      }
      const first = entries[0]!;
      expect(
        (
          await historyStore.getVisitorHistory(
            first.credential.visitorId as Parameters<
              HistoryStore['getVisitorHistory']
            >[0],
            20,
          )
        ).stats.games,
      ).toBe(1);
      if (count === 2) {
        const originalCode = (
          finished!.view as { public: { room: { code: string } } }
        ).public.room.code;
        for (const entry of entries) {
          const sequence = sequences.get(entry.client)!;
          sequences.set(entry.client, sequence + 1);
          const response = await request(entry.client, {
            type: 'series.continue',
            ...meta(`continue-${entry.credential.playerId}`, sequence),
            expectedStateVersion: version,
            continue: true,
          });
          expect(response.type).toBe('response.ok');
          version = response.stateVersion as number;
        }
        const next = await game.all[0]!.waitFor(
          (event) =>
            event.type === 'state.player' && event.stateVersion === version,
        );
        const publicState = (
          next.view as {
            public: {
              room: { code: string };
              game: { gameId: string; phase: string };
              series: { roundNumber: number; phase: string };
            };
          }
        ).public;
        expect(publicState.room.code).toBe(originalCode);
        expect(publicState.series).toMatchObject({
          roundNumber: 2,
          phase: 'playing',
        });
        expect(publicState.game.phase).not.toBe('finished');
      }
    },
  );

  it('keeps a finished authority pending after the first write failure and retries exactly once through history', async () => {
    const historyStore = new FailOnceHistoryStore();
    const { wsUrl } = await start(undefined, historyStore);
    const game = await setupGame(2, wsUrl);
    const entries = await Promise.all(
      game.all.map(async (client) => ({
        client,
        credential: await client.waitFor(
          (event) => event.type === 'session.established',
        ),
      })),
    );
    const sequences = new Map(game.all.map((client) => [client, 3]));
    let version = game.startedVersion;
    let finishedState: ReceivedEvent | undefined;
    for (let step = 0; step < 80 && !finishedState; step += 1) {
      const state = await game.all[0]!.waitFor(
        (event) =>
          event.type === 'state.player' && event.stateVersion === version,
      );
      const publicGame = (
        state.view as {
          public: {
            game: { phase: string; currentActorId: string; defenderId: string };
          };
        }
      ).public.game;
      if (publicGame.phase === 'finished') {
        finishedState = state;
        break;
      }
      const actor = entries.find(
        (entry) => entry.credential.playerId === publicGame.currentActorId,
      )!;
      const actorState = await actor.client.waitFor(
        (event) =>
          event.type === 'state.player' && event.stateVersion === version,
      );
      const hand = (
        actorState.view as {
          private: { hand: Array<{ id: string; kind: string }> };
        }
      ).private.hand;
      const card = hand.find((item) => item.kind === 'standard');
      if (!card) throw new Error('unfinished actor has no attack card');
      const attackSequence = sequences.get(actor.client)!;
      sequences.set(actor.client, attackSequence + 1);
      const attacked = await request(actor.client, {
        type: 'game.action',
        ...meta(`persist-attack-${step}`, attackSequence),
        expectedStateVersion: version,
        action: { kind: 'play-card', cardId: card.id },
      });
      version = attacked.stateVersion as number;
      const afterAttack = await game.all[0]!.waitFor(
        (event) =>
          event.type === 'state.player' && event.stateVersion === version,
      );
      const afterGame = (
        afterAttack.view as {
          public: { game: { phase: string; defenderId: string } };
        }
      ).public.game;
      if (afterGame.phase === 'finished') {
        finishedState = afterAttack;
        break;
      }
      const defender = entries.find(
        (entry) => entry.credential.playerId === afterGame.defenderId,
      )!;
      const defendSequence = sequences.get(defender.client)!;
      sequences.set(defender.client, defendSequence + 1);
      const collected = await request(defender.client, {
        type: 'game.action',
        ...meta(`persist-collect-${step}`, defendSequence),
        expectedStateVersion: version,
        action: { kind: 'collect' },
      });
      version = collected.stateVersion as number;
    }
    expect(finishedState).toBeDefined();
    expect(historyStore.attempts).toBe(1);
    const viewer = entries[0]!;
    const firstSequence = sequences.get(viewer.client)!;
    sequences.set(viewer.client, firstSequence + 1);
    await request(viewer.client, {
      type: 'history.get',
      ...meta('history-pending', firstSequence),
    });
    const pending = [...viewer.client.events]
      .reverse()
      .find((event) => event.type === 'history.result')!;
    expect(pending).toMatchObject({
      persistenceStatus: 'pending',
      stats: { games: 0 },
    });
    expect(historyStore.attempts).toBe(2);
    const secondSequence = sequences.get(viewer.client)!;
    await request(viewer.client, {
      type: 'history.get',
      ...meta('history-saved', secondSequence),
    });
    const saved = [...viewer.client.events]
      .reverse()
      .find((event) => event.type === 'history.result')!;
    expect(saved).toMatchObject({
      persistenceStatus: 'saved',
      stats: { games: 1 },
    });
    expect(historyStore.attempts).toBe(2);
  });
  it('isolates spectators, restores them, and applies independent chat limits', async () => {
    const { wsUrl } = await start();
    const { all, startedVersion } = await setupGame(2, wsUrl);
    const playerState = await all[0]!.waitFor(
      (event) =>
        event.type === 'state.player' && event.stateVersion === startedVersion,
    );
    const room = (playerState.view as { public: { room: { code: string } } })
      .public.room;
    const spectator = await connect(wsUrl);
    await request(spectator, {
      type: 'spectate.join',
      ...meta('watch', 1),
      nickname: '<img onerror=x>',
      roomCode: room.code,
      visitorId: 'visitor-watch',
    });
    const credential = await spectator.waitFor(
      (event) => event.type === 'spectator.established',
    );
    const view = await spectator.waitFor(
      (event) => event.type === 'state.spectator',
    );
    expect(view.view).not.toHaveProperty('private');
    expect(JSON.stringify(view)).not.toContain('reconnectToken');
    expect(JSON.stringify(view)).not.toContain('stock":[');
    const forbidden = await request(spectator, {
      type: 'game.action',
      ...meta('forbidden', 2),
      expectedStateVersion: view.stateVersion,
      action: { kind: 'pass' },
    });
    expect((forbidden.error as { code: string }).code).toBe('UNAUTHORIZED');
    for (let index = 0; index < 5; index += 1) {
      const sent = await request(spectator, {
        type: 'chat.send',
        ...meta(`chat-${index}`, index + 3),
        expectedStateVersion: view.stateVersion,
        message: `<b>消息 ${index}</b>`,
      });
      expect(sent.type).toBe('response.ok');
    }
    const limited = await request(spectator, {
      type: 'chat.send',
      ...meta('chat-limit', 8),
      expectedStateVersion: view.stateVersion,
      message: '第六条',
    });
    expect((limited.error as { code: string }).code).toBe('RATE_LIMITED');
    expect(
      all[0]!.events.some(
        (event) =>
          event.type === 'chat.message' && event.message === '<b>消息 0</b>',
      ),
    ).toBe(true);
    await spectator.close();
    clients.delete(spectator);
    const resumed = await connect(wsUrl);
    await request(resumed, {
      type: 'spectate.resume',
      ...meta('watch-resume', 1),
      roomId: credential.roomId,
      spectatorId: credential.spectatorId,
      reconnectToken: credential.reconnectToken,
      visitorId: 'visitor-watch',
    });
    await resumed.waitFor((event) => event.type === 'state.spectator');
    const history = await resumed.waitFor(
      (event) => event.type === 'chat.history',
    );
    expect(history.messages as unknown[]).toHaveLength(5);
    expect(resumed.raw.join('')).not.toContain('"private"');
  });

  it('removes a leaving spectator from public state and immediately releases capacity', async () => {
    const { wsUrl } = await start();
    const host = await connect(wsUrl);
    await request(host, {
      type: 'room.create',
      ...meta('capacity-create', 1),
      nickname: '房主',
      roomName: '观战容量',
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
    const room = (initial.view as { public: { room: { code: string } } }).public
      .room;
    const spectators: TestClient[] = [];
    for (let index = 0; index < 20; index += 1) {
      const spectator = await connect(wsUrl);
      spectators.push(spectator);
      const joined = await request(spectator, {
        type: 'spectate.join',
        ...meta(`capacity-${index}`, 1),
        nickname: `观众${index}`,
        roomCode: room.code,
        visitorId: `visitor-${index}`,
      });
      expect(joined.type).toBe('response.ok');
    }
    const overflow = await connect(wsUrl);
    const full = await request(overflow, {
      type: 'spectate.join',
      ...meta('capacity-full', 1),
      nickname: '第21人',
      roomCode: room.code,
      visitorId: 'visitor-full',
    });
    expect((full.error as { code: string }).code).toBe('SPECTATOR_FULL');
    const leaving = spectators[0]!;
    const credential = await leaving.waitFor(
      (event) => event.type === 'spectator.established',
    );
    const left = await request(leaving, {
      type: 'spectate.leave',
      ...meta('capacity-leave', 2),
      expectedStateVersion: 0,
    });
    expect(left.type).toBe('response.ok');
    const latest = await host.waitFor(
      (event) =>
        event.type === 'state.player' &&
        (
          event.view as {
            public: { room: { spectators: Array<{ spectatorId: string }> } };
          }
        ).public.room.spectators.length === 19 &&
        !(
          event.view as {
            public: { room: { spectators: Array<{ spectatorId: string }> } };
          }
        ).public.room.spectators.some(
          (item) => item.spectatorId === credential.spectatorId,
        ),
    );
    const publicSpectators = (
      latest.view as {
        public: { room: { spectators: Array<{ spectatorId: string }> } };
      }
    ).public.room.spectators;
    expect(publicSpectators).toHaveLength(19);
    expect(
      publicSpectators.some(
        (item) => item.spectatorId === credential.spectatorId,
      ),
    ).toBe(false);
    const replacement = await connect(wsUrl);
    const replacementJoin = await request(replacement, {
      type: 'spectate.join',
      ...meta('capacity-replacement', 1),
      nickname: '替补观众',
      roomCode: room.code,
      visitorId: 'visitor-replacement',
    });
    expect(replacementJoin.type).toBe('response.ok');
  });
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

  it('does not advertise and rejects an empty-table pass', async () => {
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
    ).not.toContain('pass');
    const passed = await request(actor.client, {
      type: 'game.action',
      ...meta('empty-pass', 3),
      expectedStateVersion: startedVersion,
      action: { kind: 'pass' },
    });
    expect(passed).toMatchObject({
      type: 'response.error',
      error: { code: 'ILLEGAL_ACTION' },
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
