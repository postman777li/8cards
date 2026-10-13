import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  nicknameSchema,
  playerIdSchema,
  roomCodeSchema,
  roomConfigSchema,
  roomIdSchema,
  roomNameSchema,
  type ErrorCode,
  type PlayerId,
  type PublicPlayer,
  type RoomConfig,
  type RoomId,
  type RoomPublicState,
  type SeatIndex,
} from '@8cards/shared';

export type RoomLifecycle = 'waiting' | 'started';
export interface RoomSnapshot extends RoomPublicState {
  readonly lifecycle: RoomLifecycle;
  readonly stateVersion: number;
}
export interface PlayerSession {
  readonly playerId: PlayerId;
  readonly reconnectToken: string;
  readonly room: RoomSnapshot;
  readonly stateVersion: number;
}
export interface StartedRoom {
  readonly roomId: RoomId;
  readonly config: Readonly<RoomConfig>;
  readonly players: readonly Readonly<PublicPlayer>[];
  readonly stateVersion: number;
}

export type RoomServiceErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_STARTED'
  | 'NOT_HOST'
  | 'NOT_ENOUGH_PLAYERS'
  | 'PLAYERS_NOT_READY'
  | 'STALE_STATE'
  | 'CODE_GENERATION_FAILED';

const protocolCodes: Record<RoomServiceErrorCode, ErrorCode> = {
  INVALID_INPUT: 'MALFORMED_MESSAGE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_STARTED: 'ILLEGAL_ACTION',
  NOT_HOST: 'WRONG_ACTOR',
  NOT_ENOUGH_PLAYERS: 'ILLEGAL_ACTION',
  PLAYERS_NOT_READY: 'ILLEGAL_ACTION',
  STALE_STATE: 'STALE_STATE',
  CODE_GENERATION_FAILED: 'INTERNAL_ERROR',
};

export class RoomServiceError extends Error {
  readonly protocolCode: ErrorCode;
  constructor(
    readonly code: RoomServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomServiceError';
    this.protocolCode = protocolCodes[code];
  }
}

interface StoredPlayer extends PublicPlayer {
  tokenDigest: Buffer;
}
interface StoredRoom {
  roomId: RoomId;
  name: string;
  code: string;
  config: RoomConfig;
  players: StoredPlayer[];
  lifecycle: RoomLifecycle;
  stateVersion: number;
}

export interface RoomStore {
  getById(roomId: RoomId): StoredRoom | undefined;
  getByCode(code: string): StoredRoom | undefined;
  save(room: StoredRoom): void;
  delete(room: StoredRoom): void;
}

export class InMemoryRoomStore implements RoomStore {
  readonly #byId = new Map<RoomId, StoredRoom>();
  readonly #byCode = new Map<string, StoredRoom>();
  getById(roomId: RoomId) {
    return this.#byId.get(roomId);
  }
  getByCode(code: string) {
    return this.#byCode.get(code);
  }
  save(room: StoredRoom) {
    this.#byId.set(room.roomId, room);
    this.#byCode.set(room.code, room);
  }
  delete(room: StoredRoom) {
    this.#byId.delete(room.roomId);
    this.#byCode.delete(room.code);
  }
}

export interface RoomServiceOptions {
  readonly store?: RoomStore;
  readonly roomId?: () => string;
  readonly playerId?: () => string;
  readonly roomCode?: () => string;
  readonly reconnectToken?: () => string;
  readonly maxCodeAttempts?: number;
}

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const secureCode = () => {
  const bytes = randomBytes(6);
  return [...bytes]
    .map((value) => codeAlphabet[value % codeAlphabet.length])
    .join('');
};
const digest = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest();
const sameDigest = (left: Buffer, token: string) => {
  const right = digest(token);
  return left.length === right.length && timingSafeEqual(left, right);
};
const invalid = (message: string): never => {
  throw new RoomServiceError('INVALID_INPUT', message);
};

export class RoomService {
  readonly #store: RoomStore;
  readonly #roomId: () => string;
  readonly #playerId: () => string;
  readonly #roomCode: () => string;
  readonly #token: () => string;
  readonly #maxCodeAttempts: number;

  constructor(options: RoomServiceOptions = {}) {
    this.#store = options.store ?? new InMemoryRoomStore();
    this.#roomId = options.roomId ?? randomUUID;
    this.#playerId = options.playerId ?? randomUUID;
    this.#roomCode = options.roomCode ?? secureCode;
    this.#token =
      options.reconnectToken ?? (() => randomBytes(32).toString('base64url'));
    this.#maxCodeAttempts = options.maxCodeAttempts ?? 16;
  }

  createRoom(input: {
    nickname: string;
    roomName: string;
    config: RoomConfig;
  }): PlayerSession {
    const nickname = nicknameSchema.safeParse(input.nickname);
    const name = roomNameSchema.safeParse(input.roomName);
    const config = roomConfigSchema.safeParse(input.config);
    if (!nickname.success || !name.success || !config.success) {
      return invalid('房间创建参数无效');
    }
    let code: string | undefined;
    for (let attempt = 0; attempt < this.#maxCodeAttempts; attempt += 1) {
      const candidate = roomCodeSchema.safeParse(this.#roomCode());
      if (!candidate.success) return invalid('短码生成器返回了无效短码');
      if (!this.#store.getByCode(candidate.data)) {
        code = candidate.data;
        break;
      }
    }
    if (!code)
      throw new RoomServiceError(
        'CODE_GENERATION_FAILED',
        '无法生成唯一房间短码',
      );
    const roomId = roomIdSchema.parse(this.#roomId());
    const playerId = playerIdSchema.parse(this.#playerId());
    const token = this.#token();
    const room: StoredRoom = {
      roomId,
      name: name.data,
      code,
      config: { ...config.data },
      lifecycle: 'waiting',
      stateVersion: 0,
      players: [
        {
          identity: 'player',
          playerId,
          nickname: nickname.data,
          seat: 0,
          isHost: true,
          connection: 'online',
          readiness: 'not-ready',
          tokenDigest: digest(token),
        },
      ],
    };
    this.#store.save(room);
    return this.#session(room, playerId, token);
  }

  joinRoom(input: { roomCode: string; nickname: string }): PlayerSession {
    const code = roomCodeSchema.safeParse(input.roomCode);
    const nickname = nicknameSchema.safeParse(input.nickname);
    if (!code.success || !nickname.success) return invalid('加入房间参数无效');
    const room = this.#store.getByCode(code.data);
    if (!room) throw new RoomServiceError('ROOM_NOT_FOUND', '房间不存在');
    if (room.lifecycle === 'started')
      throw new RoomServiceError('ROOM_STARTED', '房间已经开始');
    if (room.players.length >= room.config.playerCount)
      throw new RoomServiceError('ROOM_FULL', '房间已满');
    const occupied = new Set(room.players.map((player) => player.seat));
    const seat = Array.from(
      { length: room.config.playerCount },
      (_, index) => index as SeatIndex,
    ).find((value) => !occupied.has(value));
    if (seat === undefined) throw new RoomServiceError('ROOM_FULL', '房间已满');
    const playerId = playerIdSchema.parse(this.#playerId());
    const token = this.#token();
    room.players.push({
      identity: 'player',
      playerId,
      nickname: nickname.data,
      seat,
      isHost: false,
      connection: 'online',
      readiness: 'not-ready',
      tokenDigest: digest(token),
    });
    room.stateVersion += 1;
    return this.#session(room, playerId, token);
  }

  getRoomByCode(codeInput: string): RoomSnapshot {
    const code = roomCodeSchema.safeParse(codeInput);
    if (!code.success) return invalid('房间短码无效');
    const room = this.#store.getByCode(code.data);
    if (!room) throw new RoomServiceError('ROOM_NOT_FOUND', '房间不存在');
    return this.#snapshot(room);
  }

  setReady(input: {
    roomId: RoomId;
    playerId: PlayerId;
    reconnectToken: string;
    ready: boolean;
    expectedStateVersion: number;
  }): RoomSnapshot {
    const { room, player } = this.#authenticate(input);
    this.#waiting(room);
    this.#version(room, input.expectedStateVersion);
    player.readiness = input.ready ? 'ready' : 'not-ready';
    room.stateVersion += 1;
    return this.#snapshot(room);
  }

  startRoom(input: {
    roomId: RoomId;
    playerId: PlayerId;
    reconnectToken: string;
    expectedStateVersion: number;
  }): StartedRoom {
    const { room, player } = this.#authenticate(input);
    this.#waiting(room);
    this.#version(room, input.expectedStateVersion);
    if (!player.isHost)
      throw new RoomServiceError('NOT_HOST', '只有房主可以开始');
    if (room.players.length !== room.config.playerCount)
      throw new RoomServiceError('NOT_ENOUGH_PLAYERS', '房间人数不足');
    if (
      room.players.some(
        (candidate) => !candidate.isHost && candidate.readiness !== 'ready',
      )
    )
      throw new RoomServiceError('PLAYERS_NOT_READY', '仍有玩家未准备');
    room.lifecycle = 'started';
    room.stateVersion += 1;
    const snapshot = this.#snapshot(room);
    return {
      roomId: snapshot.roomId,
      config: snapshot.config,
      players: snapshot.players,
      stateVersion: snapshot.stateVersion,
    };
  }

  leaveRoom(input: {
    roomId: RoomId;
    playerId: PlayerId;
    reconnectToken: string;
    expectedStateVersion: number;
  }): RoomSnapshot | undefined {
    const { room, player } = this.#authenticate(input);
    this.#waiting(room);
    this.#version(room, input.expectedStateVersion);
    room.players = room.players.filter((candidate) => candidate !== player);
    if (room.players.length === 0) {
      this.#store.delete(room);
      return undefined;
    }
    if (player.isHost) {
      const host = [...room.players].sort((a, b) => a.seat - b.seat)[0];
      if (host) host.isHost = true;
    }
    room.stateVersion += 1;
    return this.#snapshot(room);
  }

  markDisconnected(input: {
    roomId: RoomId;
    playerId: PlayerId;
    reconnectToken: string;
    expectedStateVersion: number;
  }): RoomSnapshot {
    const { room, player } = this.#authenticate(input);
    this.#version(room, input.expectedStateVersion);
    if (player.connection !== 'disconnected') {
      player.connection = 'disconnected';
      room.stateVersion += 1;
    }
    return this.#snapshot(room);
  }

  restoreSession(input: {
    roomId: RoomId;
    playerId: PlayerId;
    reconnectToken: string;
  }): PlayerSession {
    const { room, player } = this.#authenticate(input);
    const token = this.#token();
    player.tokenDigest = digest(token);
    if (player.connection !== 'online') {
      player.connection = 'online';
      room.stateVersion += 1;
    }
    return this.#session(room, player.playerId, token);
  }

  #authenticate(input: {
    roomId: RoomId;
    playerId: PlayerId;
    reconnectToken: string;
  }) {
    const room = this.#store.getById(input.roomId);
    const player = room?.players.find(
      (candidate) => candidate.playerId === input.playerId,
    );
    if (
      !room ||
      !player ||
      !sameDigest(player.tokenDigest, input.reconnectToken)
    )
      throw new RoomServiceError('UNAUTHORIZED', '会话凭证无效');
    return { room, player };
  }
  #waiting(room: StoredRoom) {
    if (room.lifecycle !== 'waiting')
      throw new RoomServiceError('ROOM_STARTED', '房间已经开始');
  }
  #version(room: StoredRoom, expected: number) {
    if (room.stateVersion !== expected)
      throw new RoomServiceError('STALE_STATE', '房间状态已更新');
  }
  #snapshot(room: StoredRoom): RoomSnapshot {
    return {
      roomId: room.roomId,
      name: room.name,
      code: room.code,
      config: { ...room.config },
      players: room.players.map((player) => ({
        identity: player.identity,
        playerId: player.playerId,
        nickname: player.nickname,
        seat: player.seat,
        isHost: player.isHost,
        connection: player.connection,
        readiness: player.readiness,
      })),
      spectators: [],
      lifecycle: room.lifecycle,
      stateVersion: room.stateVersion,
    };
  }
  #session(
    room: StoredRoom,
    playerId: PlayerId,
    reconnectToken: string,
  ): PlayerSession {
    return {
      playerId,
      reconnectToken,
      room: this.#snapshot(room),
      stateVersion: room.stateVersion,
    };
  }
}

export const createRoomSharePath = (codeInput: string) =>
  `/room/${roomCodeSchema.parse(codeInput)}`;
export const createRoomShareUrl = (baseUrl: string, codeInput: string) =>
  `${baseUrl.replace(/\/$/, '')}${createRoomSharePath(codeInput)}`;
