import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createApp, type AppServer } from './app.js';
import type { RealtimeClock } from './realtime.js';

type Event = { type: string; [key: string]: unknown };

class FakeClock implements RealtimeClock {
  time = Date.parse('2026-10-13T04:00:00.000Z');
  tasks: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  now = () => this.time;
  schedule(delay: number, callback: () => void) {
    const task = { at: this.time + delay, callback, cancelled: false };
    this.tasks.push(task);
    return task;
  }
  cancel(handle: unknown) {
    (handle as (typeof this.tasks)[number]).cancelled = true;
  }
  advance(milliseconds: number) {
    this.time += milliseconds;
    for (const task of this.tasks.filter(
      (item) => !item.cancelled && item.at <= this.time,
    )) {
      task.cancelled = true;
      task.callback();
    }
  }
  force(index: number) {
    this.tasks[index]?.callback();
  }
}

class Client {
  events: Event[] = [];
  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) =>
      this.events.push(JSON.parse(data.toString()) as Event),
    );
  }
  static async connect(url: string) {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    return new Client(socket);
  }
  send(event: unknown) {
    this.socket.send(JSON.stringify(event));
  }
  async find(predicate: (event: Event) => boolean) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = this.events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('event timeout');
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    this.socket.close();
    await closed;
  }
}

const servers = new Set<AppServer>();
const clients = new Set<Client>();
afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
  await Promise.all(
    [...servers].map(async (server) => {
      await server.realtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  servers.clear();
});

const meta = (requestId: string, actionSequence: number) => ({
  protocolVersion: 1,
  requestId,
  actionSequence,
});
const send = async (client: Client, event: Record<string, unknown>) => {
  client.send(event);
  return client.find((item) => item.requestId === event.requestId);
};
const state = (client: Client, version: number) =>
  client.find(
    (item) => item.type === 'state.player' && item.stateVersion === version,
  );
const publicOf = (event: Event) =>
  (
    event.view as {
      public: {
        room: { code: string };
        game: {
          currentActorId: string;
          turnDeadline: string;
          table: Array<{ purpose: string }>;
          players: Array<{ playerId: string; handCount: number }>;
          trumpSuit: string;
          attackerId: string;
          defenderId: string;
        } | null;
        series?: {
          phase: string;
          participants: Array<{ playerId: string; score: number }>;
        };
      };
    }
  ).public;

async function setup(count: 2 | 3 | 4) {
  const clock = new FakeClock();
  let randomState = 12345;
  const server = createApp({
    clock,
    random: () =>
      (randomState = (randomState * 1664525 + 1013904223) >>> 0) /
      0x1_0000_0000,
  });
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  const players = [await Client.connect(url)];
  clients.add(players[0]!);
  await send(players[0]!, {
    type: 'room.create',
    ...meta('create', 1),
    nickname: 'P0',
    roomName: '计时桌',
    config: {
      playerCount: count,
      allowSpectators: true,
      allowChat: true,
      turnTimeoutSeconds: 20,
    },
  });
  const credentials: Event[] = [
    await players[0]!.find((event) => event.type === 'session.established'),
  ];
  const initial = await state(players[0]!, 0);
  const code = publicOf(initial).room.code;
  for (let index = 1; index < count; index += 1) {
    const client = await Client.connect(url);
    clients.add(client);
    players.push(client);
    await send(client, {
      type: 'room.join',
      ...meta(`join-${index}`, 1),
      nickname: `P${index}`,
      roomCode: code,
    });
    credentials.push(
      await client.find((event) => event.type === 'session.established'),
    );
  }
  let version = count - 1;
  for (let index = 1; index < count; index += 1)
    await send(players[index]!, {
      type: 'room.ready',
      ...meta(`ready-${index}`, 2),
      expectedStateVersion: version++,
      ready: true,
    });
  const started = await send(players[0]!, {
    type: 'room.start',
    ...meta('start', 2),
    expectedStateVersion: version,
  });
  return {
    clock,
    url,
    players,
    credentials,
    version: started.stateVersion as number,
  };
}

describe('authoritative turn timers', () => {
  it.each([2, 3, 4] as const)(
    'publishes one 20 second deadline and auto-passes in %i-player games',
    async (count) => {
      const game = await setup(count);
      const views = await Promise.all(
        game.players.map((client) => state(client, game.version)),
      );
      expect(views.map((view) => publicOf(view).game?.turnDeadline)).toEqual(
        Array(count).fill('2026-10-13T04:00:20.000Z'),
      );
      game.clock.advance(20_000);
      const advanced = await state(game.players[0]!, game.version + 1);
      expect(publicOf(advanced).game?.turnDeadline).toBe(
        '2026-10-13T04:00:40.000Z',
      );
    },
  );

  it('auto-collects on defense and ignores a cancelled callback after a timely action', async () => {
    const game = await setup(2);
    const views = await Promise.all(
      game.players.map((client) => state(client, game.version)),
    );
    const actorId = publicOf(views[0]!).game!.currentActorId;
    const actorIndex = game.credentials.findIndex(
      (item) => item.playerId === actorId,
    );
    const actorView = views[actorIndex]!;
    const card = (
      actorView.view as {
        private: { hand: Array<{ id: string; kind: string }> };
      }
    ).private.hand.find((item) => item.kind === 'standard')!;
    await send(game.players[actorIndex]!, {
      type: 'game.action',
      ...meta('attack', actorIndex === 0 ? 3 : 3),
      expectedStateVersion: game.version,
      action: { kind: 'play-card', cardId: card.id },
    });
    const oldDeadline = publicOf(
      await state(game.players[0]!, game.version + 1),
    ).game!.turnDeadline;
    game.clock.force(0);
    expect(
      game.players[0]!.events.some(
        (item) =>
          item.type === 'state.player' &&
          item.stateVersion === game.version + 2,
      ),
    ).toBe(false);
    game.clock.advance(20_000);
    const collected = await state(game.players[0]!, game.version + 2);
    expect(publicOf(collected).game!.table).toEqual([]);
    expect(publicOf(collected).game!.turnDeadline).not.toBe(oldDeadline);
  });

  it('keeps the original deadline across a disconnect and fires after the remaining ten seconds', async () => {
    const game = await setup(2);
    const initial = await state(game.players[0]!, game.version);
    const deadline = publicOf(initial).game!.turnDeadline;
    const actorId = publicOf(initial).game!.currentActorId;
    const actorIndex = game.credentials.findIndex(
      (credential) => credential.playerId === actorId,
    );
    game.clock.advance(10_000);
    await game.players[actorIndex]!.close();
    clients.delete(game.players[actorIndex]!);
    const observer = game.players[actorIndex === 0 ? 1 : 0]!;
    const disconnected = await state(observer, game.version + 1);
    expect(publicOf(disconnected).game!.turnDeadline).toBe(deadline);
    expect(publicOf(disconnected).game!.currentActorId).toBe(actorId);
    game.clock.advance(9_999);
    expect(
      observer.events.some((event) => event.stateVersion === game.version + 2),
    ).toBe(false);
    game.clock.advance(1);
    const timedOut = await state(observer, game.version + 2);
    expect(publicOf(timedOut).game!.currentActorId).not.toBe(actorId);
    expect(publicOf(timedOut).game!.turnDeadline).toBe(
      '2026-10-13T04:00:40.000Z',
    );
  });

  it('keeps the original deadline when a disconnected player resumes before expiry', async () => {
    const game = await setup(2);
    const initial = await state(game.players[0]!, game.version);
    const deadline = publicOf(initial).game!.turnDeadline;
    const target = game.players[1]!;
    const credential = game.credentials[1]!;
    game.clock.advance(5_000);
    await target.close();
    clients.delete(target);
    await state(game.players[0]!, game.version + 1);
    game.clock.advance(5_000);
    const resumed = await Client.connect(game.url);
    clients.add(resumed);
    await send(resumed, {
      type: 'session.resume',
      ...meta('resume-before-deadline', 1),
      roomId: credential.roomId,
      playerId: credential.playerId,
      reconnectToken: credential.reconnectToken,
    });
    const online = await state(resumed, game.version + 2);
    expect(publicOf(online).game!.turnDeadline).toBe(deadline);
    game.clock.advance(10_000);
    const timedOut = await state(resumed, game.version + 3);
    expect(publicOf(timedOut).game!.turnDeadline).toBe(
      '2026-10-13T04:00:40.000Z',
    );
  });

  it('auto-collects when the current defender is disconnected', async () => {
    const game = await setup(2);
    const views = await Promise.all(
      game.players.map((client) => state(client, game.version)),
    );
    const actorId = publicOf(views[0]!).game!.currentActorId;
    const actorIndex = game.credentials.findIndex(
      (credential) => credential.playerId === actorId,
    );
    const defenderIndex = actorIndex === 0 ? 1 : 0;
    const card = (
      views[actorIndex]!.view as {
        private: { hand: Array<{ id: string; kind: string }> };
      }
    ).private.hand.find((item) => item.kind === 'standard')!;
    await send(game.players[actorIndex]!, {
      type: 'game.action',
      ...meta('attack-before-defender-drop', 3),
      expectedStateVersion: game.version,
      action: { kind: 'play-card', cardId: card.id },
    });
    const defending = await state(game.players[actorIndex]!, game.version + 1);
    const deadline = publicOf(defending).game!.turnDeadline;
    await game.players[defenderIndex]!.close();
    clients.delete(game.players[defenderIndex]!);
    const disconnected = await state(
      game.players[actorIndex]!,
      game.version + 2,
    );
    expect(publicOf(disconnected).game!.turnDeadline).toBe(deadline);
    expect(publicOf(disconnected).game!.currentActorId).toBe(
      game.credentials[defenderIndex]!.playerId,
    );
    game.clock.advance(20_000);
    const collected = await state(game.players[actorIndex]!, game.version + 3);
    expect(publicOf(collected).game!.table).toEqual([]);
    expect(publicOf(collected).game!.currentActorId).toBe(actorId);
  });

  it('does not reset or invalidate the deadline when the trump two is exchanged', async () => {
    const game = await setup(4);
    const views = await Promise.all(
      game.players.map((client) => state(client, game.version)),
    );
    const deadline = publicOf(views[0]!).game!.turnDeadline;
    const trumpSuit = publicOf(views[0]!).game!.trumpSuit;
    const ownerIndex = views.findIndex((view) =>
      (
        view.view as {
          private: {
            hand: Array<{ kind: string; suit?: string; rank?: string }>;
          };
        }
      ).private.hand.some(
        (card) =>
          card.kind === 'standard' &&
          card.suit === trumpSuit &&
          card.rank === '2',
      ),
    );
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    game.clock.advance(10_000);
    const exchanged = await send(game.players[ownerIndex]!, {
      type: 'game.action',
      ...meta('exchange-before-timeout', 3),
      expectedStateVersion: game.version,
      action: { kind: 'exchange-trump-two' },
    });
    expect(exchanged.stateVersion).toBe(game.version + 1);
    const afterExchange = await state(
      game.players[ownerIndex]!,
      game.version + 1,
    );
    expect(publicOf(afterExchange).game!.turnDeadline).toBe(deadline);
    game.clock.advance(10_000);
    const timedOut = await state(game.players[ownerIndex]!, game.version + 2);
    expect(publicOf(timedOut).game!.turnDeadline).toBe(
      '2026-10-13T04:00:40.000Z',
    );
  });
});

describe('disconnect and session restoration', () => {
  it('automatically expires and broadcasts a pending seat swap after 30 seconds', async () => {
    const clock = new FakeClock();
    const server = createApp({ clock });
    servers.add(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const host = await Client.connect(url);
    const guest = await Client.connect(url);
    clients.add(host);
    clients.add(guest);
    await send(host, {
      type: 'room.create',
      ...meta('seat-create', 1),
      nickname: 'A',
      roomName: '换座计时',
      config: {
        playerCount: 3,
        allowSpectators: true,
        allowChat: true,
        turnTimeoutSeconds: 20,
      },
    });
    const created = await state(host, 0);
    const joined = await send(guest, {
      type: 'room.join',
      ...meta('seat-join', 1),
      nickname: 'B',
      roomCode: publicOf(created).room.code,
    });
    expect(joined.stateVersion).toBe(1);
    await send(host, {
      type: 'room.seat.request',
      ...meta('seat-request', 2),
      expectedStateVersion: 1,
      targetSeat: 1,
    });
    const pending = await state(guest, 2);
    expect(
      (pending.view as { public: { room: { seatSwapRequest: unknown } } })
        .public.room.seatSwapRequest,
    ).not.toBeNull();

    clock.advance(29_999);
    expect(
      guest.events.some(
        (event) => event.type === 'state.player' && event.stateVersion === 3,
      ),
    ).toBe(false);
    clock.advance(1);
    const expired = await state(guest, 3);
    expect(
      (expired.view as { public: { room: { seatSwapRequest: unknown } } })
        .public.room.seatSwapRequest,
    ).toBeNull();
  });

  it('forfeits the series only after the three-minute reconnect grace expires', async () => {
    const game = await setup(2);
    const disconnectedPlayerId = game.credentials[1]!.playerId as string;
    await game.players[1]!.close();
    clients.delete(game.players[1]!);
    await state(game.players[0]!, game.version + 1);

    game.clock.advance(179_999);
    expect(
      game.players[0]!.events.some(
        (event) =>
          (
            event.view as
              { public?: { series?: { phase: string } } } | undefined
          )?.public?.series?.phase === 'series-result',
      ),
    ).toBe(false);

    game.clock.advance(1);
    const forfeited = await game.players[0]!.find(
      (event) =>
        (event.view as { public?: { series?: { phase: string } } } | undefined)
          ?.public?.series?.phase === 'series-result',
    );
    const series = publicOf(forfeited).series!;
    expect(
      series.participants.find((item) => item.playerId === disconnectedPlayerId)
        ?.score,
    ).toBe(-1);
    expect(series.participants.reduce((sum, item) => sum + item.score, 0)).toBe(
      0,
    );
  });

  it('atomically replaces an online socket without increasing the public version', async () => {
    const game = await setup(2);
    const old = game.players[1]!;
    const credential = game.credentials[1]!;
    const closed = once(old.socket, 'close');
    const replacement = await Client.connect(game.url);
    clients.add(replacement);
    const response = await send(replacement, {
      type: 'session.resume',
      ...meta('replace', 1),
      roomId: credential.roomId,
      playerId: credential.playerId,
      reconnectToken: credential.reconnectToken,
    });
    expect(response.stateVersion).toBe(game.version);
    expect((await closed)[0]).toBe(4001);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      game.players[0]!.events.some(
        (event) =>
          event.type === 'state.player' &&
          (event.stateVersion as number) > game.version,
      ),
    ).toBe(false);
  });

  it.each([2, 3, 4] as const)(
    'retains and restores private state after timer progress for %i players',
    async (count) => {
      const game = await setup(count);
      const target = game.players[1]!;
      const credential = game.credentials[1]!;
      await state(target, game.version);
      await target.close();
      clients.delete(target);
      const disconnected = await state(game.players[0]!, game.version + 1);
      const member = publicOf(disconnected).room as unknown as {
        players: Array<{ playerId: string; connection: string }>;
      };
      expect(
        member.players.find((item) => item.playerId === credential.playerId)
          ?.connection,
      ).toBe('disconnected');
      const beforeTimeoutGame = publicOf(disconnected).game!;
      game.clock.advance(20_000);
      const timedOut = await state(game.players[0]!, game.version + 2);
      const afterTimeoutGame = publicOf(timedOut).game!;
      expect(afterTimeoutGame.turnDeadline).toBe('2026-10-13T04:00:40.000Z');
      expect(afterTimeoutGame.currentActorId).not.toBe(
        beforeTimeoutGame.currentActorId,
      );
      expect(afterTimeoutGame.table).toHaveLength(1);
      expect(afterTimeoutGame.table[0]?.purpose).toBe('attack');
      const resumed = await Client.connect(game.url);
      clients.add(resumed);
      const response = await send(resumed, {
        type: 'session.resume',
        ...meta('resume', 1),
        roomId: credential.roomId,
        playerId: credential.playerId,
        reconnectToken: credential.reconnectToken,
      });
      expect(response).toMatchObject({
        type: 'response.ok',
        stateVersion: game.version + 3,
      });
      const newCredential = await resumed.find(
        (event) => event.type === 'session.established',
      );
      expect(newCredential.reconnectToken).not.toBe(credential.reconnectToken);
      const restored = await state(resumed, game.version + 3);
      expect(
        (restored.view as { private: { hand: unknown[] } }).private.hand,
      ).toHaveLength(
        afterTimeoutGame.players.find(
          (item) => item.playerId === credential.playerId,
        )!.handCount,
      );
      const retryCount = resumed.events.length;
      resumed.send({
        type: 'session.resume',
        ...meta('resume', 1),
        roomId: credential.roomId,
        playerId: credential.playerId,
        reconnectToken: credential.reconnectToken,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        resumed.events
          .slice(retryCount)
          .some(
            (event) => event.reconnectToken === newCredential.reconnectToken,
          ),
      ).toBe(true);
      const rejected = await Client.connect(game.url);
      clients.add(rejected);
      const denial = await send(rejected, {
        type: 'session.resume',
        ...meta('old-token', 1),
        roomId: credential.roomId,
        playerId: credential.playerId,
        reconnectToken: credential.reconnectToken,
      });
      expect((denial.error as { code: string }).code).toBe('UNAUTHORIZED');
    },
  );
});
