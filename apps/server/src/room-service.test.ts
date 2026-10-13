import { describe, expect, it } from 'vitest';

import type { PlayerId, RoomId } from '@8cards/shared';

import {
  InMemoryRoomStore,
  RoomService,
  RoomServiceError,
  createRoomSharePath,
  createRoomShareUrl,
} from './room-service.js';

const config = (playerCount: 2 | 3 | 4 = 2) => ({
  playerCount,
  allowSpectators: true,
  allowChat: true,
  turnTimeoutSeconds: 20 as const,
});

class TrackingDetachedStore extends InMemoryRoomStore {
  inserts = 0;
  updateAttempts = 0;
  updates = 0;
  deletes = 0;
  failNextUpdate = false;

  override insert(...args: Parameters<InMemoryRoomStore['insert']>) {
    const inserted = super.insert(...args);
    if (inserted) this.inserts += 1;
    return inserted;
  }

  override update(...args: Parameters<InMemoryRoomStore['update']>) {
    this.updateAttempts += 1;
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return false;
    }
    const updated = super.update(...args);
    if (updated) this.updates += 1;
    return updated;
  }

  override delete(...args: Parameters<InMemoryRoomStore['delete']>) {
    const deleted = super.delete(...args);
    if (deleted) this.deletes += 1;
    return deleted;
  }
}

const factory = (
  codes = ['ABC123'],
  store: InMemoryRoomStore = new InMemoryRoomStore(),
) => {
  let player = 0;
  let token = 0;
  let code = 0;
  const service = new RoomService({
    store,
    roomId: () => `room-${player + 1}`,
    playerId: () => `player-${++player}`,
    reconnectToken: () => `secret-token-${++token}`,
    roomCode: () => codes[Math.min(code++, codes.length - 1)]!,
    maxCodeAttempts: codes.length,
  });
  return { service, store };
};

const expectCode = (action: () => unknown, code: string) => {
  try {
    action();
    throw new Error('expected room service error');
  } catch (error) {
    expect(error).toBeInstanceOf(RoomServiceError);
    expect((error as RoomServiceError).code).toBe(code);
  }
};

describe('RoomService creation and joining', () => {
  it.each([2, 3, 4] as const)(
    'creates a trimmed %i-player room with a host in seat zero',
    (count) => {
      const { service } = factory();
      const created = service.createRoom({
        nickname: ' 房主 ',
        roomName: ' 周末牌局 ',
        config: config(count),
      });
      expect(created.room).toMatchObject({
        name: '周末牌局',
        code: 'ABC123',
        lifecycle: 'waiting',
        stateVersion: 0,
      });
      expect(created.room.players[0]).toMatchObject({
        nickname: '房主',
        seat: 0,
        isHost: true,
        connection: 'online',
      });
      expect(created.reconnectToken).toBe('secret-token-1');
      expect(createRoomSharePath(created.room.code)).toBe('/room/ABC123');
      expect(
        createRoomShareUrl('https://cards.example/', created.room.code),
      ).toBe('https://cards.example/room/ABC123');
    },
  );

  it('validates inputs before storing anything', () => {
    const { service } = factory();
    expectCode(
      () =>
        service.createRoom({ nickname: ' ', roomName: 'x', config: config() }),
      'INVALID_INPUT',
    );
    expectCode(() => service.getRoomByCode('ABC123'), 'ROOM_NOT_FOUND');
  });

  it('retries collisions and fails without a partial room after exhaustion', () => {
    const sharedStore = new InMemoryRoomStore();
    const first = factory().service.createRoom({
      nickname: 'a',
      roomName: 'a',
      config: config(),
    });
    const fixed = new RoomService({
      store: sharedStore,
      roomId: () => 'r1',
      playerId: () => 'p1',
      reconnectToken: () => 't1',
      roomCode: () => 'ABC123',
    });
    fixed.createRoom({ nickname: 'a', roomName: 'a', config: config() });
    const retrying = new RoomService({
      store: sharedStore,
      roomId: () => 'r2',
      playerId: () => 'p2',
      reconnectToken: () => 't2',
      roomCode: (() => {
        const values = ['ABC123', 'XYZ789'];
        return () => values.shift()!;
      })(),
      maxCodeAttempts: 2,
    });
    expect(
      retrying.createRoom({ nickname: 'b', roomName: 'b', config: config() })
        .room.code,
    ).toBe('XYZ789');
    const failing = new RoomService({
      store: sharedStore,
      roomCode: () => 'ABC123',
      maxCodeAttempts: 2,
    });
    expectCode(
      () =>
        failing.createRoom({ nickname: 'c', roomName: 'c', config: config() }),
      'CODE_GENERATION_FAILED',
    );
    expect(first.room.code).toBe('ABC123');
    expectCode(() => failing.getRoomByCode('ZZZ999'), 'ROOM_NOT_FOUND');
  });

  it('assigns the lowest open seat, permits duplicate nicknames, and enforces capacity', () => {
    const { service } = factory();
    const host = service.createRoom({
      nickname: '同名',
      roomName: '房间',
      config: config(2),
    });
    const guest = service.joinRoom({
      roomCode: host.room.code,
      nickname: '同名',
    });
    expect(guest.room.players.map((player) => player.seat)).toEqual([0, 1]);
    expect(guest.playerId).not.toBe(host.playerId);
    expect(guest.reconnectToken).not.toBe(host.reconnectToken);
    expectCode(
      () => service.joinRoom({ roomCode: host.room.code, nickname: '第三人' }),
      'ROOM_FULL',
    );
    expectCode(
      () => service.joinRoom({ roomCode: 'abc123', nickname: 'x' }),
      'INVALID_INPUT',
    );
    expectCode(
      () => service.joinRoom({ roomCode: 'ZZZ999', nickname: 'x' }),
      'ROOM_NOT_FOUND',
    );
  });
});

describe('RoomService permissions and lifecycle', () => {
  it('requires the host, exact capacity, and all guests ready before starting', () => {
    const { service } = factory();
    const host = service.createRoom({
      nickname: 'h',
      roomName: 'r',
      config: config(),
    });
    expectCode(
      () =>
        service.startRoom({
          roomId: host.room.roomId,
          playerId: host.playerId,
          reconnectToken: host.reconnectToken,
          expectedStateVersion: 0,
        }),
      'NOT_ENOUGH_PLAYERS',
    );
    const guest = service.joinRoom({ roomCode: host.room.code, nickname: 'g' });
    expectCode(
      () =>
        service.startRoom({
          roomId: host.room.roomId,
          playerId: guest.playerId,
          reconnectToken: guest.reconnectToken,
          expectedStateVersion: 1,
        }),
      'NOT_HOST',
    );
    expectCode(
      () =>
        service.startRoom({
          roomId: host.room.roomId,
          playerId: host.playerId,
          reconnectToken: host.reconnectToken,
          expectedStateVersion: 1,
        }),
      'PLAYERS_NOT_READY',
    );
    const ready = service.setReady({
      roomId: host.room.roomId,
      playerId: guest.playerId,
      reconnectToken: guest.reconnectToken,
      ready: true,
      expectedStateVersion: 1,
    });
    const started = service.startRoom({
      roomId: host.room.roomId,
      playerId: host.playerId,
      reconnectToken: host.reconnectToken,
      expectedStateVersion: ready.stateVersion,
    });
    expect(started.stateVersion).toBe(3);
    expect(started.players.map((player) => player.seat)).toEqual([0, 1]);
    expectCode(
      () =>
        service.startRoom({
          roomId: host.room.roomId,
          playerId: host.playerId,
          reconnectToken: host.reconnectToken,
          expectedStateVersion: 3,
        }),
      'ROOM_STARTED',
    );
    expectCode(
      () => service.joinRoom({ roomCode: host.room.code, nickname: 'late' }),
      'ROOM_STARTED',
    );
  });

  it('authenticates readiness and rejects stale conflicting writes without mutation', () => {
    const { service } = factory();
    const host = service.createRoom({
      nickname: 'h',
      roomName: 'r',
      config: config(),
    });
    const guest = service.joinRoom({ roomCode: host.room.code, nickname: 'g' });
    expectCode(
      () =>
        service.setReady({
          roomId: host.room.roomId,
          playerId: guest.playerId,
          reconnectToken: host.reconnectToken,
          ready: true,
          expectedStateVersion: 1,
        }),
      'UNAUTHORIZED',
    );
    const once = service.setReady({
      roomId: host.room.roomId,
      playerId: guest.playerId,
      reconnectToken: guest.reconnectToken,
      ready: true,
      expectedStateVersion: 1,
    });
    expectCode(
      () =>
        service.setReady({
          roomId: host.room.roomId,
          playerId: guest.playerId,
          reconnectToken: guest.reconnectToken,
          ready: false,
          expectedStateVersion: 1,
        }),
      'STALE_STATE',
    );
    expect(service.getRoomByCode(host.room.code)).toEqual(once);
  });

  it('releases seats, transfers host to the lowest seat, and destroys an empty room', () => {
    const { service } = factory();
    const host = service.createRoom({
      nickname: 'h',
      roomName: 'r',
      config: config(3),
    });
    const second = service.joinRoom({
      roomCode: host.room.code,
      nickname: 's',
    });
    const third = service.joinRoom({ roomCode: host.room.code, nickname: 't' });
    const afterHost = service.leaveRoom({
      roomId: host.room.roomId,
      playerId: host.playerId,
      reconnectToken: host.reconnectToken,
      expectedStateVersion: 2,
    })!;
    expect(
      afterHost.players.find((player) => player.playerId === second.playerId)
        ?.isHost,
    ).toBe(true);
    const replacement = service.joinRoom({
      roomCode: host.room.code,
      nickname: 'new',
    });
    expect(
      replacement.room.players.find(
        (player) => player.playerId === replacement.playerId,
      )?.seat,
    ).toBe(0);
    let version = replacement.stateVersion;
    service.leaveRoom({
      roomId: host.room.roomId,
      playerId: third.playerId,
      reconnectToken: third.reconnectToken,
      expectedStateVersion: version,
    });
    version += 1;
    service.leaveRoom({
      roomId: host.room.roomId,
      playerId: replacement.playerId,
      reconnectToken: replacement.reconnectToken,
      expectedStateVersion: version,
    });
    version += 1;
    expect(
      service.leaveRoom({
        roomId: host.room.roomId,
        playerId: second.playerId,
        reconnectToken: second.reconnectToken,
        expectedStateVersion: version,
      }),
    ).toBeUndefined();
    expectCode(() => service.getRoomByCode(host.room.code), 'ROOM_NOT_FOUND');
    expectCode(
      () =>
        service.restoreSession({
          roomId: host.room.roomId,
          playerId: host.playerId,
          reconnectToken: host.reconnectToken,
        }),
      'UNAUTHORIZED',
    );
  });
});

describe('RoomService sessions and snapshots', () => {
  it('marks disconnection, restores with rotation, and rejects replay uniformly', () => {
    const { service } = factory();
    const host = service.createRoom({
      nickname: 'h',
      roomName: 'r',
      config: config(),
    });
    const disconnected = service.markDisconnected({
      roomId: host.room.roomId,
      playerId: host.playerId,
      reconnectToken: host.reconnectToken,
      expectedStateVersion: 0,
    });
    expect(disconnected.players[0]?.connection).toBe('disconnected');
    const restored = service.restoreSession({
      roomId: host.room.roomId,
      playerId: host.playerId,
      reconnectToken: host.reconnectToken,
    });
    expect(restored.stateVersion).toBe(2);
    expect(restored.reconnectToken).not.toBe(host.reconnectToken);
    expectCode(
      () =>
        service.restoreSession({
          roomId: host.room.roomId,
          playerId: host.playerId,
          reconnectToken: host.reconnectToken,
        }),
      'UNAUTHORIZED',
    );
    expectCode(
      () =>
        service.restoreSession({
          roomId: 'wrong' as RoomId,
          playerId: host.playerId,
          reconnectToken: restored.reconnectToken,
        }),
      'UNAUTHORIZED',
    );
    expectCode(
      () =>
        service.restoreSession({
          roomId: host.room.roomId,
          playerId: 'wrong' as PlayerId,
          reconnectToken: restored.reconnectToken,
        }),
      'UNAUTHORIZED',
    );
    expectCode(
      () =>
        service.restoreSession({
          roomId: host.room.roomId,
          playerId: host.playerId,
          reconnectToken: 'almost',
        }),
      'UNAUTHORIZED',
    );
  });

  it('rotates an online token without changing public state version', () => {
    const { service } = factory();
    const host = service.createRoom({
      nickname: 'h',
      roomName: 'r',
      config: config(),
    });
    const restored = service.restoreSession({
      roomId: host.room.roomId,
      playerId: host.playerId,
      reconnectToken: host.reconnectToken,
    });
    expect(restored.stateVersion).toBe(0);
  });

  it('returns defensive copies and never serializes token material', () => {
    const { service } = factory();
    const host = service.createRoom({
      nickname: 'h',
      roomName: 'r',
      config: config(),
    });
    (host.room.players as { nickname: string }[])[0]!.nickname = 'tampered';
    (host.room.config as { allowChat: boolean }).allowChat = false;
    const fresh = service.getRoomByCode(host.room.code);
    expect(fresh.players[0]?.nickname).toBe('h');
    expect(fresh.config.allowChat).toBe(true);
    const serialized = JSON.stringify(fresh);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toMatch(/token|digest|connectionId/i);
  });
});

describe('RoomService detached persistence boundary', () => {
  it('explicitly persists every successful detached-record transition', () => {
    const waitingStore = new TrackingDetachedStore();
    const { service } = factory(['DET123'], waitingStore);
    const host = service.createRoom({
      nickname: 'host',
      roomName: 'detached',
      config: config(3),
    });
    const second = service.joinRoom({
      roomCode: host.room.code,
      nickname: 'second',
    });
    const third = service.joinRoom({
      roomCode: host.room.code,
      nickname: 'third',
    });
    service.setReady({
      roomId: host.room.roomId,
      playerId: second.playerId,
      reconnectToken: second.reconnectToken,
      ready: true,
      expectedStateVersion: 2,
    });
    service.leaveRoom({
      roomId: host.room.roomId,
      playerId: host.playerId,
      reconnectToken: host.reconnectToken,
      expectedStateVersion: 3,
    });

    const afterTransfer = service.getRoomByCode(host.room.code);
    expect(afterTransfer.players).toHaveLength(2);
    expect(
      afterTransfer.players.find(
        (player) => player.playerId === second.playerId,
      )?.isHost,
    ).toBe(true);
    expect(waitingStore).toMatchObject({ inserts: 1, updates: 4, deletes: 0 });

    const replacement = service.joinRoom({
      roomCode: host.room.code,
      nickname: 'replacement',
    });
    expect(
      service
        .getRoomByCode(host.room.code)
        .players.find((player) => player.playerId === replacement.playerId)
        ?.seat,
    ).toBe(0);

    let version = replacement.stateVersion;
    service.leaveRoom({
      roomId: host.room.roomId,
      playerId: third.playerId,
      reconnectToken: third.reconnectToken,
      expectedStateVersion: version++,
    });
    service.leaveRoom({
      roomId: host.room.roomId,
      playerId: replacement.playerId,
      reconnectToken: replacement.reconnectToken,
      expectedStateVersion: version++,
    });
    service.leaveRoom({
      roomId: host.room.roomId,
      playerId: second.playerId,
      reconnectToken: second.reconnectToken,
      expectedStateVersion: version,
    });
    expect(waitingStore.deletes).toBe(1);

    const startedStore = new TrackingDetachedStore();
    const startedFactory = factory(['STA123'], startedStore);
    const startHost = startedFactory.service.createRoom({
      nickname: 'host',
      roomName: 'start',
      config: config(),
    });
    const startGuest = startedFactory.service.joinRoom({
      roomCode: startHost.room.code,
      nickname: 'guest',
    });
    const ready = startedFactory.service.setReady({
      roomId: startHost.room.roomId,
      playerId: startGuest.playerId,
      reconnectToken: startGuest.reconnectToken,
      ready: true,
      expectedStateVersion: 1,
    });
    startedFactory.service.startRoom({
      roomId: startHost.room.roomId,
      playerId: startHost.playerId,
      reconnectToken: startHost.reconnectToken,
      expectedStateVersion: ready.stateVersion,
    });
    expect(
      startedFactory.service.getRoomByCode(startHost.room.code),
    ).toMatchObject({ lifecycle: 'started', stateVersion: 3 });
    expect(startedStore).toMatchObject({ inserts: 1, updates: 3 });
  });

  it('persists connection and token changes while failed transitions save nothing', () => {
    const store = new TrackingDetachedStore();
    const { service } = factory(['SES123'], store);
    const host = service.createRoom({
      nickname: 'host',
      roomName: 'session',
      config: config(),
    });
    service.markDisconnected({
      roomId: host.room.roomId,
      playerId: host.playerId,
      reconnectToken: host.reconnectToken,
      expectedStateVersion: 0,
    });
    const restored = service.restoreSession({
      roomId: host.room.roomId,
      playerId: host.playerId,
      reconnectToken: host.reconnectToken,
    });
    const rotatedOnline = service.restoreSession({
      roomId: host.room.roomId,
      playerId: host.playerId,
      reconnectToken: restored.reconnectToken,
    });
    expect(rotatedOnline.stateVersion).toBe(2);
    expect(store.updates).toBe(3);
    expectCode(
      () =>
        service.restoreSession({
          roomId: host.room.roomId,
          playerId: host.playerId,
          reconnectToken: restored.reconnectToken,
        }),
      'UNAUTHORIZED',
    );
    expect(store.updateAttempts).toBe(3);

    store.failNextUpdate = true;
    expectCode(
      () =>
        service.setReady({
          roomId: host.room.roomId,
          playerId: host.playerId,
          reconnectToken: rotatedOnline.reconnectToken,
          ready: true,
          expectedStateVersion: 2,
        }),
      'STALE_STATE',
    );
    expect(service.getRoomByCode(host.room.code)).toMatchObject({
      stateVersion: 2,
      players: [expect.objectContaining({ readiness: 'not-ready' })],
    });
    expect(store.updates).toBe(3);
    expect(store.updateAttempts).toBe(4);
  });
});
