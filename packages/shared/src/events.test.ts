import { describe, expect, it } from 'vitest';

import type { ClientEvent, ServerEvent } from './events.js';
import {
  clientEventSchema,
  publicServerEventSchema,
  serverEventSchema,
} from './events.js';
import {
  gamePublicStateSchema,
  opponentViewSchema,
  playerViewSchema,
  spectatorViewSchema,
} from './game-state.js';

const requestMeta = {
  protocolVersion: 1,
  requestId: 'req-1',
  actionSequence: 1,
} as const;
const publicSnapshot = {
  stateVersion: 0,
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
        readiness: 'ready',
      },
      {
        identity: 'player',
        playerId: 'p2',
        nickname: '乙',
        seat: 1,
        isHost: false,
        connection: 'online',
        readiness: 'ready',
      },
    ],
    spectators: [],
  },
  game: null,
} as const;

describe('client protocol validation', () => {
  const validEvents: unknown[] = [
    {
      type: 'room.create',
      ...requestMeta,
      nickname: '甲',
      roomName: '好友桌',
      config: publicSnapshot.room.config,
    },
    { type: 'room.join', ...requestMeta, nickname: '乙', roomCode: 'ABC123' },
    {
      type: 'session.resume',
      ...requestMeta,
      roomId: 'room-1',
      playerId: 'p1',
      reconnectToken: 'a'.repeat(32),
    },
    { type: 'room.leave', ...requestMeta, expectedStateVersion: 0 },
    {
      type: 'room.ready',
      ...requestMeta,
      expectedStateVersion: 0,
      ready: true,
    },
    { type: 'room.start', ...requestMeta, expectedStateVersion: 0 },
    {
      type: 'chat.send',
      ...requestMeta,
      expectedStateVersion: 0,
      message: '你好',
    },
    {
      type: 'spectate.join',
      ...requestMeta,
      nickname: '观众',
      roomCode: 'ABC123',
      visitorId: 'visitor-1',
    },
    { type: 'spectate.leave', ...requestMeta, expectedStateVersion: 0 },
    {
      type: 'game.action',
      ...requestMeta,
      expectedStateVersion: 0,
      action: { kind: 'play-card', cardId: 'hearts-A' },
    },
    {
      type: 'game.action',
      ...requestMeta,
      expectedStateVersion: 0,
      action: {
        kind: 'beat-card',
        cardId: 'spades-A',
        targetCardId: 'spades-K',
      },
    },
    {
      type: 'game.action',
      ...requestMeta,
      expectedStateVersion: 0,
      action: { kind: 'pass' },
    },
    {
      type: 'game.action',
      ...requestMeta,
      expectedStateVersion: 0,
      action: { kind: 'collect' },
    },
    {
      type: 'game.action',
      ...requestMeta,
      expectedStateVersion: 0,
      action: { kind: 'exchange-trump-two' },
    },
  ];

  it.each(validEvents)('accepts a valid event', (event) => {
    expect(clientEventSchema.safeParse(event).success).toBe(true);
  });

  it.each([
    { type: 'room.join', ...requestMeta, nickname: '乙' },
    { type: 'unknown.event', ...requestMeta },
    { type: 'room.join', ...requestMeta, nickname: '乙', roomCode: 'abc123' },
    {
      type: 'room.ready',
      ...requestMeta,
      expectedStateVersion: 0,
      ready: 'yes',
    },
    { type: 'room.leave', ...requestMeta, expectedStateVersion: -1 },
    {
      type: 'room.leave',
      ...requestMeta,
      actionSequence: 0,
      expectedStateVersion: 0,
    },
    {
      type: 'room.leave',
      ...requestMeta,
      requestId: '',
      expectedStateVersion: 0,
    },
  ])('rejects malformed or out-of-range data', (event) => {
    expect(clientEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('visibility boundaries', () => {
  const playerView = {
    audience: 'player',
    viewerPlayerId: 'p1',
    public: publicSnapshot,
    private: {
      hand: [{ id: 'hearts-A', kind: 'standard', suit: 'hearts', rank: 'A' }],
      legalActionTypes: ['play-card'],
    },
  } as const;

  it('allows only the current player view to contain a private hand', () => {
    expect(playerViewSchema.safeParse(playerView).success).toBe(true);
    expect(
      opponentViewSchema.safeParse({
        audience: 'opponent',
        public: publicSnapshot,
        private: playerView.private,
      }).success,
    ).toBe(false);
    expect(
      spectatorViewSchema.safeParse({
        audience: 'spectator',
        public: publicSnapshot,
        private: playerView.private,
      }).success,
    ).toBe(false);
  });

  it.each([
    'handsByPlayer',
    'reconnectToken',
    'randomSeed',
    'drawPile',
    'connectionId',
  ])('rejects sensitive field %s in public data', (field) => {
    const snapshot = { ...publicSnapshot, [field]: 'secret' };
    expect(
      serverEventSchema.safeParse({
        type: 'state.public',
        protocolVersion: 1,
        stateVersion: 0,
        snapshot,
      }).success,
    ).toBe(false);
  });
});

describe('server protocol validation', () => {
  it('exposes only the normalized public finish reason', () => {
    const game = {
      gameId: 'game-1',
      phase: 'finished',
      trumpSuit: 'hearts',
      exposedCard: null,
      stockCount: 0,
      table: [],
      players: [
        { playerId: 'p1', handCount: 0, role: 'attacker', team: 'solo' },
        { playerId: 'p2', handCount: 2, role: 'defender', team: 'solo' },
      ],
      currentActorId: null,
      attackerId: 'p1',
      defenderId: 'p2',
      turnDeadline: null,
      winnerPlayerIds: ['p1'],
      loserPlayerIds: ['p2'],
      resultReason: 'stuck-with-jokers',
    };
    expect(gamePublicStateSchema.parse(game).resultReason).toBe(
      'stuck-with-jokers',
    );
    expect(
      gamePublicStateSchema.safeParse({ ...game, resultReason: 'secret-state' })
        .success,
    ).toBe(false);
    expect(
      gamePublicStateSchema.safeParse({
        ...game,
        loserPlayerIds: ['p1', 'p2', 'p3'],
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      type: 'response.ok',
      protocolVersion: 1,
      requestId: 'req-1',
      stateVersion: 0,
    },
    {
      type: 'response.error',
      protocolVersion: 1,
      requestId: 'req-1',
      error: { code: 'STALE_STATE', message: '状态已更新', retryable: true },
    },
    {
      type: 'session.established',
      protocolVersion: 1,
      roomId: 'room-1',
      playerId: 'p1',
      reconnectToken: 'a'.repeat(32),
    },
    {
      type: 'state.player',
      protocolVersion: 1,
      stateVersion: 0,
      view: {
        audience: 'player',
        viewerPlayerId: 'p1',
        public: publicSnapshot,
        private: { hand: [], legalActionTypes: [] },
      },
    },
    {
      type: 'state.spectator',
      protocolVersion: 1,
      stateVersion: 0,
      view: { audience: 'spectator', public: publicSnapshot },
    },
    {
      type: 'state.public',
      protocolVersion: 1,
      stateVersion: 0,
      snapshot: publicSnapshot,
    },
    {
      type: 'chat.message',
      protocolVersion: 1,
      stateVersion: 0,
      messageId: 'msg-1',
      senderPlayerId: 'p1',
      senderNickname: '甲',
      message: '你好',
      sentAt: '2026-10-13T12:00:00+08:00',
      chatVersion: 1,
    },
  ])('accepts valid individual and public events', (event) => {
    expect(serverEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects unknown fields instead of silently stripping them', () => {
    const result = serverEventSchema.safeParse({
      type: 'state.spectator',
      protocolVersion: 1,
      stateVersion: 0,
      view: { audience: 'spectator', public: publicSnapshot },
      hand: [],
    });
    expect(result.success).toBe(false);
  });

  it('keeps session credentials individual and strictly validated', () => {
    const credential = {
      type: 'session.established',
      protocolVersion: 1,
      roomId: 'room-1',
      playerId: 'p1',
      reconnectToken: 'a'.repeat(32),
    };
    expect(serverEventSchema.safeParse(credential).success).toBe(true);
    expect(
      serverEventSchema.safeParse({ ...credential, unexpected: true }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({ ...credential, reconnectToken: 'short' })
        .success,
    ).toBe(false);
    expect(publicServerEventSchema.safeParse(credential).success).toBe(false);
  });
});

function clientEventType(event: ClientEvent): string {
  switch (event.type) {
    case 'room.create':
    case 'room.join':
    case 'session.resume':
    case 'room.leave':
    case 'room.ready':
    case 'room.start':
    case 'room.seat.request':
    case 'room.seat.respond':
    case 'chat.send':
    case 'reaction.send':
    case 'spectate.join':
    case 'spectate.resume':
    case 'spectate.leave':
    case 'game.action':
    case 'series.continue':
    case 'series.exit':
    case 'history.get':
      return event.type;
    default:
      return event satisfies never;
  }
}

function serverEventType(event: ServerEvent): string {
  switch (event.type) {
    case 'response.ok':
    case 'response.error':
    case 'session.established':
    case 'spectator.established':
    case 'state.player':
    case 'state.spectator':
    case 'state.public':
    case 'chat.message':
    case 'reaction.show':
    case 'chat.history':
    case 'history.result':
      return event.type;
    default:
      return event satisfies never;
  }
}

it('supports exhaustive type narrowing for both event directions', () => {
  const client = clientEventSchema.parse({
    type: 'room.leave',
    ...requestMeta,
    expectedStateVersion: 0,
  });
  const server = serverEventSchema.parse({
    type: 'response.ok',
    protocolVersion: 1,
    requestId: 'req-1',
    stateVersion: 0,
  });
  expect(clientEventType(client)).toBe('room.leave');
  expect(serverEventType(server)).toBe('response.ok');
});
