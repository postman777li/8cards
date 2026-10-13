import { describe, expect, it } from 'vitest';
import {
  connectToLobby,
  LobbyConnectionError,
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
});
