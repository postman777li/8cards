import { describe, expect, it } from 'vitest';
import {
  connectToLobby,
  LobbyConnectionError,
  resumeLobby,
  resolveWebSocketUrl,
} from './realtime-client.js';

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

const snapshot = {
  audience: 'player',
  viewerPlayerId: 'p1',
  public: {
    stateVersion: 1,
    room: {
      roomId: 'room-1',
      name: '好友桌',
      code: 'ABC123',
      config: {
        playerCount: 2,
        allowSpectators: true,
        allowChat: true,
        turnTimeoutSeconds: 20,
      },
      players: [
        {
          identity: 'player',
          playerId: 'p1',
          nickname: '甲',
          seat: 0,
          isHost: true,
          connection: 'online',
          readiness: 'not-ready',
        },
      ],
      spectators: [],
    },
    game: null,
  },
  private: { hand: [], legalActionTypes: [] },
};
const meta = { protocolVersion: 1 } as const;

describe('websocket lobby client', () => {
  it('derives ws/wss URLs and validates configured protocols', () => {
    expect(
      resolveWebSocketUrl({
        protocol: 'https:',
        host: 'game.test',
        hostname: 'game.test',
      }),
    ).toContain('wss://');
    expect(
      resolveWebSocketUrl(
        { protocol: 'http:', host: 'game.test', hostname: 'game.test' },
        'ws://localhost:4000/ws',
      ),
    ).toBe('ws://localhost:4000/ws');
    expect(() =>
      resolveWebSocketUrl(
        { protocol: 'http:', host: 'x', hostname: 'x' },
        'http://bad',
      ),
    ).toThrow();
  });

  it('sends create defaults with sequence one and waits for the complete correlated result', async () => {
    const socket = new FakeSocket();
    const operation = connectToLobby(
      { kind: 'create', nickname: '甲', roomName: '好友桌', playerCount: 2 },
      { url: 'ws://test/ws', createSocket: () => socket as never },
    );
    socket.open();
    const request = JSON.parse(socket.sent[0]!);
    expect(request).toMatchObject({
      type: 'room.create',
      actionSequence: 1,
      config: {
        playerCount: 2,
        allowSpectators: true,
        allowChat: true,
        turnTimeoutSeconds: 20,
      },
    });
    socket.message({
      type: 'state.player',
      ...meta,
      stateVersion: 1,
      view: snapshot,
    });
    socket.message({
      type: 'response.ok',
      ...meta,
      requestId: request.requestId,
      stateVersion: 1,
    });
    socket.message({
      type: 'session.established',
      ...meta,
      roomId: 'room-1',
      playerId: 'p1',
      reconnectToken: 'a'.repeat(32),
    });
    await expect(operation.promise).resolves.toMatchObject({
      roomId: 'room-1',
      playerId: 'p1',
    });
  });

  it('preserves server errors and closes on malformed messages or cancellation', async () => {
    const socket = new FakeSocket();
    const operation = connectToLobby(
      { kind: 'join', nickname: '乙', roomCode: 'ABC123' },
      { url: 'ws://test/ws', createSocket: () => socket as never },
    );
    socket.open();
    const request = JSON.parse(socket.sent[0]!);
    socket.message({
      type: 'response.error',
      ...meta,
      requestId: request.requestId,
      error: { code: 'ROOM_FULL', message: '房间已满', retryable: false },
    });
    await expect(operation.promise).rejects.toMatchObject({
      message: '房间已满',
      protocolError: { code: 'ROOM_FULL' },
    });
    expect(socket.closed).toBe(true);

    const second = new FakeSocket();
    const cancelled = connectToLobby(
      { kind: 'join', nickname: '乙', roomCode: 'ABC123' },
      { url: 'ws://test/ws', createSocket: () => second as never },
    );
    cancelled.cancel();
    await expect(cancelled.promise).rejects.toBeInstanceOf(
      LobbyConnectionError,
    );
    expect(second.closed).toBe(true);
  });

  it('keeps the socket live, uses increasing sequences and only updates from authoritative snapshots', async () => {
    const socket = new FakeSocket();
    const operation = connectToLobby(
      { kind: 'create', nickname: '甲', roomName: '好友桌', playerCount: 2 },
      { url: 'ws://test/ws', createSocket: () => socket as never },
    );
    socket.open();
    const create = JSON.parse(socket.sent[0]!);
    socket.message({
      type: 'response.ok',
      ...meta,
      requestId: create.requestId,
      stateVersion: 1,
    });
    socket.message({
      type: 'session.established',
      ...meta,
      roomId: 'room-1',
      playerId: 'p1',
      reconnectToken: 'a'.repeat(32),
    });
    socket.message({
      type: 'state.player',
      ...meta,
      stateVersion: 1,
      view: snapshot,
    });
    const connection = await operation.promise;
    const seen: number[] = [];
    connection.subscribe((next) => seen.push(next.public.stateVersion));

    const ready = connection.ready(true);
    const readyRequest = JSON.parse(socket.sent[1]!);
    expect(readyRequest).toMatchObject({
      type: 'room.ready',
      actionSequence: 2,
      expectedStateVersion: 1,
      ready: true,
    });
    socket.message({
      type: 'response.error',
      ...meta,
      requestId: readyRequest.requestId,
      error: {
        code: 'STALE_STATE',
        message: '房间状态已更新',
        retryable: true,
      },
    });
    await expect(ready).rejects.toMatchObject({ message: '房间状态已更新' });
    expect(connection.view.public.stateVersion).toBe(1);

    const nextSnapshot = {
      ...snapshot,
      public: { ...snapshot.public, stateVersion: 2 },
    };
    socket.message({
      type: 'state.player',
      ...meta,
      stateVersion: 2,
      view: nextSnapshot,
    });
    expect(seen).toEqual([2]);
    const start = connection.start();
    const startRequest = JSON.parse(socket.sent[2]!);
    expect(startRequest).toMatchObject({
      type: 'room.start',
      actionSequence: 3,
      expectedStateVersion: 2,
    });
    socket.message({
      type: 'response.ok',
      ...meta,
      requestId: startRequest.requestId,
      stateVersion: 3,
    });
    await expect(start).resolves.toBeUndefined();
  });

  it('resumes with sequence one and adopts only the rotated credential', async () => {
    const socket = new FakeSocket();
    const operation = resumeLobby(
      {
        roomId: 'room-1' as never,
        playerId: 'p1' as never,
        reconnectToken: 'a'.repeat(32),
      },
      { url: 'ws://test/ws', createSocket: () => socket as never },
    );
    socket.open();
    const request = JSON.parse(socket.sent[0]!);
    expect(request).toMatchObject({
      type: 'session.resume',
      actionSequence: 1,
      reconnectToken: 'a'.repeat(32),
    });
    socket.message({
      type: 'response.ok',
      ...meta,
      requestId: request.requestId,
      stateVersion: 1,
    });
    socket.message({
      type: 'session.established',
      ...meta,
      roomId: 'room-1',
      playerId: 'p1',
      reconnectToken: 'b'.repeat(32),
    });
    socket.message({
      type: 'state.player',
      ...meta,
      stateVersion: 1,
      view: snapshot,
    });
    await expect(operation.promise).resolves.toMatchObject({
      reconnectToken: 'b'.repeat(32),
    });
  });

  it('leaves with the latest version and rejects duplicate in-flight submission', async () => {
    const socket = new FakeSocket();
    const operation = connectToLobby(
      { kind: 'create', nickname: '甲', roomName: '好友桌', playerCount: 2 },
      { url: 'ws://test/ws', createSocket: () => socket as never },
    );
    socket.open();
    const create = JSON.parse(socket.sent[0]!);
    socket.message({
      type: 'response.ok',
      ...meta,
      requestId: create.requestId,
      stateVersion: 1,
    });
    socket.message({
      type: 'session.established',
      ...meta,
      roomId: 'room-1',
      playerId: 'p1',
      reconnectToken: 'a'.repeat(32),
    });
    socket.message({
      type: 'state.player',
      ...meta,
      stateVersion: 1,
      view: snapshot,
    });
    const connection = await operation.promise;

    const leaving = connection.leave();
    const leaveRequest = JSON.parse(socket.sent[1]!);
    expect(leaveRequest).toMatchObject({
      type: 'room.leave',
      actionSequence: 2,
      expectedStateVersion: 1,
    });
    await expect(connection.leave()).rejects.toMatchObject({
      message: '操作正在处理中',
    });
    expect(socket.sent).toHaveLength(2);
    socket.message({
      type: 'response.ok',
      ...meta,
      requestId: leaveRequest.requestId,
      stateVersion: 2,
    });
    await expect(leaving).resolves.toBeUndefined();
  });

  it('submits game actions with the latest version and permits only one in flight', async () => {
    const socket = new FakeSocket();
    const operation = connectToLobby(
      { kind: 'create', nickname: '甲', roomName: '好友桌', playerCount: 2 },
      { url: 'ws://test/ws', createSocket: () => socket as never },
    );
    socket.open();
    const create = JSON.parse(socket.sent[0]!);
    socket.message({
      type: 'response.ok',
      ...meta,
      requestId: create.requestId,
      stateVersion: 1,
    });
    socket.message({
      type: 'session.established',
      ...meta,
      roomId: 'room-1',
      playerId: 'p1',
      reconnectToken: 'a'.repeat(32),
    });
    socket.message({
      type: 'state.player',
      ...meta,
      stateVersion: 1,
      view: snapshot,
    });
    const connection = await operation.promise;

    const action = connection.action({
      kind: 'play-card',
      cardId: 'hearts-A' as never,
    });
    const request = JSON.parse(socket.sent[1]!);
    expect(request).toMatchObject({
      type: 'game.action',
      actionSequence: 2,
      expectedStateVersion: 1,
      action: { kind: 'play-card', cardId: 'hearts-A' },
    });
    await expect(connection.action({ kind: 'pass' })).rejects.toMatchObject({
      message: '操作正在处理中',
    });
    expect(socket.sent).toHaveLength(2);
    socket.message({
      type: 'response.error',
      ...meta,
      requestId: request.requestId,
      error: {
        code: 'ILLEGAL_ACTION',
        message: '此牌不能出',
        retryable: false,
      },
    });
    await expect(action).rejects.toMatchObject({ message: '此牌不能出' });
    expect(connection.view.public.stateVersion).toBe(1);

    const remainingActions = [
      {
        kind: 'beat-card',
        cardId: 'spades-K' as never,
        targetCardId: 'spades-Q' as never,
      },
      { kind: 'pass' },
      { kind: 'collect' },
      { kind: 'exchange-trump-two' },
    ] as const;
    for (const [index, value] of remainingActions.entries()) {
      const pending = connection.action(value);
      const sent = JSON.parse(socket.sent[index + 2]!);
      expect(sent).toMatchObject({
        type: 'game.action',
        actionSequence: index + 3,
        expectedStateVersion: 1,
        action: value,
      });
      socket.message({
        type: 'response.error',
        ...meta,
        requestId: sent.requestId,
        error: {
          code: 'ILLEGAL_ACTION',
          message: '测试拒绝',
          retryable: false,
        },
      });
      await expect(pending).rejects.toMatchObject({ message: '测试拒绝' });
    }
  });
});
