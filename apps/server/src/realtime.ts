import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  PROTOCOL_VERSION,
  serverEventSchema,
  requestIdSchema,
  safeParseClientEvent,
  type AvatarId,
  type ClientEvent,
  type ErrorCode,
  type IndividualServerEvent,
  type PlayerId,
  type RequestId,
  type RoomId,
  type SpectatorId,
  type VisitorId,
  type SeatIndex,
  type ChatMessage,
  type ServerEvent,
  type GameRecord,
  type RoomSeries,
} from '@8cards/shared';
import {
  FourPlayerEngineError,
  ThreePlayerEngineError,
  TwoPlayerEngineError,
  applyFourPlayerAction,
  applyThreePlayerAction,
  applyTwoPlayerAction,
  createFourPlayerState,
  createInitialDeal,
  createThreePlayerState,
  createTwoPlayerState,
  type FourPlayerAction,
  type ThreePlayerAction,
  type TwoPlayerAction,
  type TwoPlayerState,
  type ThreePlayerState,
} from '@8cards/game-engine';
import { WebSocket, WebSocketServer } from 'ws';

import {
  projectPlayerView,
  projectSpectatorView,
  type AuthorityState,
} from './projection.js';
import {
  RoomService,
  RoomServiceError,
  type PlayerSession,
  type RoomSnapshot,
} from './room-service.js';
import { SqliteHistoryStore, type HistoryStore } from './history-store.js';
import { settlementOutcome } from './settlement.js';
import {
  chooseRoundMultiplier,
  finalizeSeries,
  scoreRankedRound,
  resolveFourPlayerTeamOutcome,
  scoreSeriesRound,
} from './series.js';

const CACHE_LIMIT = 64;
export const MAX_MESSAGE_BYTES = 16 * 1024;

interface PlayerIdentity {
  kind: 'player';
  roomId: RoomId;
  playerId: PlayerId;
  reconnectToken: string;
  visitorId: VisitorId;
}
interface SpectatorIdentity {
  kind: 'spectator';
  roomId: RoomId;
  spectatorId: SpectatorId;
  reconnectToken: string;
  visitorId: VisitorId;
}
type Identity = PlayerIdentity | SpectatorIdentity;
interface CachedRequest {
  requestId: RequestId;
  canonical: string;
  responses: readonly IndividualServerEvent[];
}
interface ConnectionState {
  identity?: Identity;
  nextSequence: number;
  bySequence: Map<number, CachedRequest>;
  sequenceByRequestId: Map<RequestId, number>;
  chatSentAt: number[];
  processing: Promise<void>;
}
interface SpectatorRecord {
  spectatorId: SpectatorId;
  nickname: string;
  avatarId: AvatarId;
  tokenDigest: string;
  visitorId: VisitorId;
  connection: 'online' | 'disconnected';
}
interface RealtimeRoom {
  snapshot: RoomSnapshot;
  stateVersion: number;
  authority?: AuthorityState;
  sockets: Set<WebSocket>;
  turnDeadline: string | null;
  timerGeneration: number;
  timerHandle?: unknown;
  spectators: Map<SpectatorId, SpectatorRecord>;
  chat: ChatMessage[];
  chatVersion: number;
  startedAt?: string;
  settled: boolean;
  settling: boolean;
  visitorByPlayer: Map<PlayerId, VisitorId>;
  series?: RoomSeries;
  roundScored: boolean;
  disconnectForfeits: Map<PlayerId, unknown>;
  defenseWins: Map<PlayerId, number>;
  fastestWinMs?: number;
  fastestWinners: Set<PlayerId>;
  roundFinishOrder: PlayerId[];
  originalTeams: readonly (readonly PlayerId[])[];
  seatSwapExpiryHandle?: unknown;
}

export interface RealtimeClock {
  now(): number;
  schedule(delayMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface RealtimeOptions {
  roomService?: RoomService;
  random?: () => number;
  clock?: RealtimeClock;
  historyStore?: HistoryStore;
  trustedOrigins?: ReadonlySet<string>;
}

const systemClock: RealtimeClock = {
  now: () => Date.now(),
  schedule: (delay, callback) => setTimeout(callback, delay),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const secureRandom = () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000;
const timeoutRankOrder = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
] as const;
const timeoutSuitOrder = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

const protocolError = (
  requestId: RequestId,
  code: ErrorCode,
  message: string,
  retryable = false,
): IndividualServerEvent => ({
  type: 'response.error',
  protocolVersion: PROTOCOL_VERSION,
  requestId,
  error: { code, message, retryable },
});

const mapEngineError = (error: unknown): ErrorCode => {
  if (error instanceof ProtocolFailure) return error.code;
  if (
    error instanceof TwoPlayerEngineError ||
    error instanceof ThreePlayerEngineError ||
    error instanceof FourPlayerEngineError
  )
    return error.code === 'WRONG_ACTOR' ? 'WRONG_ACTOR' : 'ILLEGAL_ACTION';
  return 'INTERNAL_ERROR';
};

class ProtocolFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class RealtimeService {
  readonly webSocketServer: WebSocketServer;
  readonly #roomService: RoomService;
  readonly #random: () => number;
  readonly #clock: RealtimeClock;
  readonly #history: HistoryStore;
  readonly #trustedOrigins: ReadonlySet<string> | undefined;
  readonly #connections = new Map<WebSocket, ConnectionState>();
  readonly #rooms = new Map<RoomId, RealtimeRoom>();
  readonly #currentSockets = new Map<string, WebSocket>();
  #closing = false;

  constructor(options: RealtimeOptions = {}) {
    this.#roomService = options.roomService ?? new RoomService();
    this.#random = options.random ?? secureRandom;
    this.#clock = options.clock ?? systemClock;
    this.#history = options.historyStore ?? new SqliteHistoryStore();
    this.#trustedOrigins = options.trustedOrigins;
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.webSocketServer.on('connection', (socket) => this.#connect(socket));
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Parameters<WebSocketServer['handleUpgrade']>[1],
    head: Buffer,
  ) {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (
      this.#trustedOrigins &&
      (!origin || !this.#trustedOrigins.has(origin))
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
      this.webSocketServer.emit('connection', webSocket, request),
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const room of this.#rooms.values()) {
      this.#cancelTimer(room);
      for (const handle of room.disconnectForfeits.values())
        this.#clock.cancel(handle);
      room.disconnectForfeits.clear();
    }
    for (const socket of this.webSocketServer.clients) socket.terminate();
    await new Promise<void>((resolve) =>
      this.webSocketServer.close(() => resolve()),
    );
    await this.#history.close();
  }

  #connect(socket: WebSocket) {
    this.#connections.set(socket, {
      nextSequence: 1,
      bySequence: new Map(),
      sequenceByRequestId: new Map(),
      chatSentAt: [],
      processing: Promise.resolve(),
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text messages only');
        return;
      }
      const state = this.#connections.get(socket);
      if (!state) return;
      state.processing = state.processing
        .then(() => this.#receive(socket, data.toString()))
        .catch(() => undefined);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      const state = this.#connections.get(socket);
      if (state?.identity) {
        const room = this.#rooms.get(state.identity.roomId);
        room?.sockets.delete(socket);
        const key = this.#identityKey(state.identity);
        if (
          !this.#closing &&
          this.#currentSockets.get(key) === socket &&
          room
        ) {
          this.#currentSockets.delete(key);
          if (state.identity.kind === 'player') {
            try {
              room.snapshot = this.#roomService.markDisconnected({
                roomId: state.identity.roomId,
                playerId: state.identity.playerId,
                reconnectToken: state.identity.reconnectToken,
                expectedStateVersion: room.snapshot.stateVersion,
              });
              room.stateVersion += 1;
              if (room.series?.phase === 'playing') {
                const playerId = state.identity.playerId;
                const previous = room.disconnectForfeits.get(playerId);
                if (previous !== undefined) this.#clock.cancel(previous);
                room.disconnectForfeits.set(
                  playerId,
                  this.#clock.schedule(180_000, () => {
                    room.disconnectForfeits.delete(playerId);
                    const player = room.snapshot.players.find(
                      (item) => item.playerId === playerId,
                    );
                    if (
                      player?.connection === 'disconnected' &&
                      room.series?.phase === 'playing'
                    ) {
                      void this.#forfeitSeries(room, playerId);
                    }
                  }),
                );
              }
              this.#broadcast(room);
            } catch {
              // A concurrent restore or room removal already superseded this close.
            }
          } else {
            const spectator = room.spectators.get(state.identity.spectatorId);
            if (spectator) {
              spectator.connection = 'disconnected';
              this.#syncSpectators(room);
              this.#broadcast(room);
            }
          }
        }
      }
      this.#connections.delete(socket);
    });
  }

  async #receive(socket: WebSocket, text: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.#send(
        socket,
        protocolError(
          'invalid-request' as RequestId,
          'MALFORMED_MESSAGE',
          '消息不是有效 JSON',
        ),
      );
      return;
    }
    const parsed = safeParseClientEvent(raw);
    if (!parsed.success) {
      const candidate =
        raw && typeof raw === 'object' && 'requestId' in raw
          ? requestIdSchema.safeParse(raw.requestId)
          : undefined;
      const requestId = candidate?.success
        ? candidate.data
        : ('invalid-request' as RequestId);
      this.#send(
        socket,
        protocolError(requestId, 'MALFORMED_MESSAGE', '消息不符合协议'),
      );
      return;
    }
    await this.#process(socket, parsed.data, canonicalize(parsed.data));
  }

  async #process(socket: WebSocket, event: ClientEvent, canonical: string) {
    const connection = this.#connections.get(socket)!;
    const cachedSequence = connection.sequenceByRequestId.get(event.requestId);
    if (cachedSequence !== undefined) {
      const cached = connection.bySequence.get(cachedSequence);
      if (cached?.canonical === canonical)
        for (const response of cached.responses) this.#send(socket, response);
      else
        this.#send(
          socket,
          protocolError(
            event.requestId,
            'DUPLICATE_REQUEST',
            'requestId 已用于不同请求',
          ),
        );
      return;
    }
    if (event.actionSequence !== connection.nextSequence) {
      const message =
        event.actionSequence > connection.nextSequence
          ? '动作序号存在跳号'
          : '动作序号已过期或已使用';
      this.#send(
        socket,
        protocolError(event.requestId, 'DUPLICATE_REQUEST', message),
      );
      return;
    }

    let response: IndividualServerEvent;
    let credential: PlayerSession | undefined;
    let visitorId: VisitorId | undefined;
    let spectatorCredential: SpectatorIdentity | undefined;
    let changedRoom: RealtimeRoom | undefined;
    try {
      const result = await this.#execute(socket, connection, event);
      response = {
        type: 'response.ok',
        protocolVersion: PROTOCOL_VERSION,
        requestId: event.requestId,
        stateVersion: result.stateVersion,
      };
      credential = result.credential;
      visitorId = result.visitorId;
      spectatorCredential = result.spectatorCredential;
      changedRoom = result.changedRoom;
    } catch (error) {
      if (error instanceof RoomServiceError)
        response = protocolError(
          event.requestId,
          error.protocolCode,
          error.message,
          error.protocolCode === 'STALE_STATE',
        );
      else
        response = protocolError(
          event.requestId,
          mapEngineError(error),
          error instanceof Error ? error.message : '服务器内部错误',
        );
    }
    connection.nextSequence += 1;
    const responses: IndividualServerEvent[] = [response];
    if (credential)
      responses.push({
        type: 'session.established',
        protocolVersion: PROTOCOL_VERSION,
        roomId: credential.room.roomId,
        playerId: credential.playerId,
        reconnectToken: credential.reconnectToken,
        ...(visitorId ? { visitorId } : {}),
      });
    if (spectatorCredential)
      responses.push({
        type: 'spectator.established',
        protocolVersion: PROTOCOL_VERSION,
        roomId: spectatorCredential.roomId,
        spectatorId: spectatorCredential.spectatorId,
        reconnectToken: spectatorCredential.reconnectToken,
        visitorId: spectatorCredential.visitorId,
      });
    if (
      (event.type === 'session.resume' ||
        event.type === 'spectate.join' ||
        event.type === 'spectate.resume') &&
      changedRoom
    )
      responses.push({
        type: 'chat.history',
        protocolVersion: PROTOCOL_VERSION,
        messages: changedRoom.chat,
      });
    if (
      (event.type === 'session.resume' || event.type === 'spectate.resume') &&
      changedRoom &&
      connection.identity
    )
      responses.push(this.#identityState(changedRoom, connection.identity));
    connection.bySequence.set(event.actionSequence, {
      requestId: event.requestId,
      canonical,
      responses,
    });
    connection.sequenceByRequestId.set(event.requestId, event.actionSequence);
    while (connection.bySequence.size > CACHE_LIMIT) {
      const oldest = connection.bySequence.keys().next().value as number;
      const removed = connection.bySequence.get(oldest);
      connection.bySequence.delete(oldest);
      if (removed) connection.sequenceByRequestId.delete(removed.requestId);
    }

    for (const item of responses) this.#send(socket, item);
    if (changedRoom)
      this.#broadcast(
        changedRoom,
        event.type === 'session.resume' || event.type === 'spectate.resume'
          ? socket
          : undefined,
      );
  }

  async #execute(
    socket: WebSocket,
    connection: ConnectionState,
    event: ClientEvent,
  ) {
    if (event.type === 'session.resume') {
      if (connection.identity || event.actionSequence !== 1)
        throw new RoomServiceError(
          'UNAUTHORIZED',
          '恢复连接必须是未绑定的新连接',
        );
      const runtime = this.#rooms.get(event.roomId);
      if (!runtime) throw new RoomServiceError('UNAUTHORIZED', '会话凭证无效');
      const previousRoomVersion = runtime.snapshot.stateVersion;
      const session = this.#roomService.restoreSession(event);
      runtime.snapshot = session.room;
      const forfeitHandle = runtime.disconnectForfeits.get(session.playerId);
      if (forfeitHandle !== undefined) {
        this.#clock.cancel(forfeitHandle);
        runtime.disconnectForfeits.delete(session.playerId);
      }
      if (session.stateVersion !== previousRoomVersion)
        runtime.stateVersion += 1;
      const identity = {
        kind: 'player' as const,
        roomId: session.room.roomId,
        playerId: session.playerId,
        reconnectToken: session.reconnectToken,
        visitorId:
          runtime.visitorByPlayer.get(session.playerId) ??
          (session.playerId as unknown as VisitorId),
      };
      connection.identity = identity;
      runtime.sockets.add(socket);
      const key = this.#identityKey(identity);
      const oldSocket = this.#currentSockets.get(key);
      this.#currentSockets.set(key, socket);
      if (oldSocket && oldSocket !== socket) {
        runtime.sockets.delete(oldSocket);
        delete this.#connections.get(oldSocket)!.identity;
        oldSocket.close(4001, 'session replaced');
      }
      return {
        stateVersion: runtime.stateVersion,
        credential: session,
        visitorId: identity.visitorId,
        changedRoom: runtime,
      };
    }
    if (event.type === 'spectate.join') {
      if (connection.identity)
        throw new RoomServiceError('UNAUTHORIZED', '连接已经绑定身份');
      const runtime = [...this.#rooms.values()].find(
        (item) => item.snapshot.code === event.roomCode,
      );
      if (!runtime) throw new RoomServiceError('ROOM_NOT_FOUND', '房间不存在');
      if (!runtime.snapshot.config.allowSpectators)
        throw new RoomServiceError('UNAUTHORIZED', '房间不允许观战');
      if (runtime.spectators.size >= 20)
        throw new ProtocolFailure('SPECTATOR_FULL', '观战席已满');
      const spectatorId = `spectator-${randomUUID()}` as SpectatorId;
      const reconnectToken = randomBytes(32).toString('base64url');
      const record: SpectatorRecord = {
        spectatorId,
        nickname: event.nickname,
        avatarId: event.avatarId ?? 'default',
        tokenDigest: this.#digest(reconnectToken),
        visitorId: event.visitorId,
        connection: 'online',
      };
      runtime.spectators.set(spectatorId, record);
      this.#syncSpectators(runtime);
      const identity: SpectatorIdentity = {
        kind: 'spectator',
        roomId: runtime.snapshot.roomId,
        spectatorId,
        reconnectToken,
        visitorId: event.visitorId,
      };
      connection.identity = identity;
      runtime.sockets.add(socket);
      this.#currentSockets.set(this.#identityKey(identity), socket);
      return {
        stateVersion: runtime.stateVersion,
        spectatorCredential: identity,
        changedRoom: runtime,
      };
    }
    if (event.type === 'spectate.resume') {
      if (connection.identity || event.actionSequence !== 1)
        throw new RoomServiceError(
          'UNAUTHORIZED',
          '恢复连接必须是未绑定的新连接',
        );
      const runtime = this.#rooms.get(event.roomId);
      const record = runtime?.spectators.get(event.spectatorId);
      if (
        !runtime ||
        !record ||
        record.visitorId !== event.visitorId ||
        record.tokenDigest !== this.#digest(event.reconnectToken)
      )
        throw new RoomServiceError('UNAUTHORIZED', '观战凭证无效');
      const reconnectToken = randomBytes(32).toString('base64url');
      record.tokenDigest = this.#digest(reconnectToken);
      record.connection = 'online';
      this.#syncSpectators(runtime);
      const identity: SpectatorIdentity = {
        kind: 'spectator',
        roomId: event.roomId,
        spectatorId: event.spectatorId,
        reconnectToken,
        visitorId: event.visitorId,
      };
      connection.identity = identity;
      runtime.sockets.add(socket);
      const key = this.#identityKey(identity);
      const oldSocket = this.#currentSockets.get(key);
      this.#currentSockets.set(key, socket);
      if (oldSocket && oldSocket !== socket) {
        runtime.sockets.delete(oldSocket);
        delete this.#connections.get(oldSocket)!.identity;
        oldSocket.close(4001, 'session replaced');
      }
      return {
        stateVersion: runtime.stateVersion,
        spectatorCredential: identity,
        changedRoom: runtime,
      };
    }
    if (event.type === 'room.create' || event.type === 'room.join') {
      if (connection.identity)
        throw new RoomServiceError('UNAUTHORIZED', '连接已经绑定玩家身份');
      const session =
        event.type === 'room.create'
          ? this.#roomService.createRoom(event)
          : this.#roomService.joinRoom(event);
      const runtime = this.#rooms.get(session.room.roomId) ?? {
        snapshot: session.room,
        stateVersion: session.stateVersion,
        sockets: new Set<WebSocket>(),
        turnDeadline: null,
        timerGeneration: 0,
        spectators: new Map(),
        chat: [],
        chatVersion: 0,
        settled: false,
        settling: false,
        visitorByPlayer: new Map(),
        roundScored: false,
        disconnectForfeits: new Map(),
        defenseWins: new Map(),
        fastestWinners: new Set(),
        roundFinishOrder: [],
        originalTeams: [],
      };
      runtime.snapshot = session.room;
      runtime.stateVersion = session.stateVersion;
      runtime.sockets.add(socket);
      this.#rooms.set(session.room.roomId, runtime);
      connection.identity = {
        kind: 'player',
        roomId: session.room.roomId,
        playerId: session.playerId,
        reconnectToken: session.reconnectToken,
        visitorId:
          event.visitorId ?? (session.playerId as unknown as VisitorId),
      };
      runtime.visitorByPlayer.set(
        session.playerId,
        connection.identity.visitorId,
      );
      this.#currentSockets.set(this.#identityKey(connection.identity), socket);
      return {
        stateVersion: runtime.stateVersion,
        credential: session,
        visitorId: connection.identity.visitorId,
        changedRoom: runtime,
      };
    }
    if (!connection.identity)
      throw new RoomServiceError('UNAUTHORIZED', '连接尚未绑定玩家身份');
    const identity = connection.identity;
    const runtime = this.#rooms.get(identity.roomId);
    if (!runtime) throw new RoomServiceError('ROOM_NOT_FOUND', '房间不存在');
    if (event.type === 'chat.send') {
      if (!runtime.snapshot.config.allowChat)
        throw new RoomServiceError('UNAUTHORIZED', '房间未开启聊天');
      const message = event.message.trim();
      const hasForbiddenControl = [...message].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return (
          (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
          code === 127
        );
      });
      if (Buffer.byteLength(message, 'utf8') > 1200 || hasForbiddenControl)
        throw new ProtocolFailure('MALFORMED_MESSAGE', '聊天内容不符合限制');
      const now = this.#clock.now();
      connection.chatSentAt = connection.chatSentAt.filter(
        (time) => now - time < 10_000,
      );
      if (connection.chatSentAt.length >= 5)
        throw new ProtocolFailure('RATE_LIMITED', '发送过于频繁，请稍后再试');
      connection.chatSentAt.push(now);
      const sender =
        identity.kind === 'player'
          ? runtime.snapshot.players.find(
              (p) => p.playerId === identity.playerId,
            )
          : runtime.spectators.get(identity.spectatorId);
      if (!sender)
        throw new RoomServiceError('UNAUTHORIZED', '身份不属于此房间');
      const chat: ChatMessage = {
        messageId: randomUUID(),
        senderNickname: sender.nickname,
        message,
        sentAt: new Date(now).toISOString(),
        chatVersion: ++runtime.chatVersion,
        ...(identity.kind === 'player'
          ? { senderPlayerId: identity.playerId }
          : { senderSpectatorId: identity.spectatorId }),
      };
      runtime.chat.push(chat);
      if (runtime.chat.length > 100) runtime.chat.shift();
      this.#broadcastEvent(runtime, {
        type: 'chat.message',
        protocolVersion: PROTOCOL_VERSION,
        stateVersion: runtime.stateVersion,
        ...chat,
      });
      return { stateVersion: runtime.stateVersion };
    }
    if (event.type === 'history.get') {
      const finished = runtime.authority?.state.phase === 'finished';
      const history = await this.#history.getVisitorHistory(
        identity.visitorId,
        20,
      );
      this.#send(socket, {
        type: 'history.result',
        protocolVersion: PROTOCOL_VERSION,
        ...history,
        ...(finished
          ? {
              persistenceStatus: runtime.settled
                ? ('saved' as const)
                : ('pending' as const),
            }
          : {}),
      });
      if (finished && !runtime.settled) await this.#settleIfFinished(runtime);
      return { stateVersion: runtime.stateVersion };
    }
    if (event.type === 'spectate.leave') {
      if (identity.kind !== 'spectator')
        throw new RoomServiceError('UNAUTHORIZED', '只有观战者可离开观战');
      runtime.spectators.delete(identity.spectatorId);
      runtime.sockets.delete(socket);
      this.#currentSockets.delete(this.#identityKey(identity));
      delete connection.identity;
      this.#syncSpectators(runtime);
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    if (identity.kind !== 'player')
      throw new RoomServiceError('UNAUTHORIZED', '观战者不能执行玩家操作');
    if (
      'expectedStateVersion' in event &&
      event.expectedStateVersion !== runtime.stateVersion
    )
      throw new RoomServiceError('STALE_STATE', '房间状态已更新');

    if (event.type === 'room.ready') {
      runtime.snapshot = this.#roomService.setReady({
        ...identity,
        ready: event.ready,
        expectedStateVersion: event.expectedStateVersion,
      });
      runtime.stateVersion = runtime.snapshot.stateVersion;
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    if (event.type === 'room.seat.request') {
      runtime.snapshot = this.#roomService.requestSeat({
        ...identity,
        targetSeat: event.targetSeat as SeatIndex,
        expectedStateVersion: event.expectedStateVersion,
      });
      runtime.stateVersion = runtime.snapshot.stateVersion;
      if (runtime.seatSwapExpiryHandle !== undefined)
        this.#clock.cancel(runtime.seatSwapExpiryHandle);
      const request = runtime.snapshot.seatSwapRequest;
      runtime.seatSwapExpiryHandle = request
        ? this.#clock.schedule(30_000, () => {
            const snapshot = this.#roomService.expireSeatRequest(
              runtime.snapshot.roomId,
              request.requestId,
            );
            delete runtime.seatSwapExpiryHandle;
            if (!snapshot) return;
            runtime.snapshot = snapshot;
            runtime.stateVersion = snapshot.stateVersion;
            this.#broadcast(runtime);
          })
        : undefined;
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    if (event.type === 'room.seat.respond') {
      runtime.snapshot = this.#roomService.respondSeat({
        ...identity,
        seatRequestId: event.seatRequestId,
        accept: event.accept,
        expectedStateVersion: event.expectedStateVersion,
      });
      runtime.stateVersion = runtime.snapshot.stateVersion;
      if (runtime.seatSwapExpiryHandle !== undefined) {
        this.#clock.cancel(runtime.seatSwapExpiryHandle);
        delete runtime.seatSwapExpiryHandle;
      }
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    if (event.type === 'room.leave') {
      const snapshot = this.#roomService.leaveRoom({
        ...identity,
        expectedStateVersion: event.expectedStateVersion,
      });
      runtime.sockets.delete(socket);
      this.#currentSockets.delete(this.#identityKey(identity));
      delete connection.identity;
      if (!snapshot) this.#rooms.delete(identity.roomId);
      else {
        runtime.snapshot = snapshot;
        runtime.stateVersion = snapshot.stateVersion;
      }
      return {
        stateVersion: snapshot?.stateVersion ?? event.expectedStateVersion + 1,
        changedRoom: snapshot ? runtime : undefined,
      };
    }
    if (event.type === 'room.start') {
      const candidate = this.#roomService.validateStartRoom({
        ...identity,
        expectedStateVersion: event.expectedStateVersion,
      });
      const players = [...candidate.players]
        .sort((a, b) => a.seat - b.seat)
        .map((player) => player.playerId);
      const deal = createInitialDeal(players, this.#random);
      const authority: AuthorityState =
        players.length === 2
          ? {
              mode: 2,
              state: createTwoPlayerState(deal, players),
              attackOwners: [],
            }
          : players.length === 3
            ? {
                mode: 3,
                state: createThreePlayerState(deal, players),
                attackOwners: [],
              }
            : {
                mode: 4,
                state: createFourPlayerState(deal, players),
                attackOwners: [],
              };
      const started = this.#roomService.startRoom({
        ...identity,
        expectedStateVersion: event.expectedStateVersion,
      });
      runtime.snapshot = {
        ...runtime.snapshot,
        lifecycle: 'started',
        stateVersion: started.stateVersion,
      };
      runtime.stateVersion = started.stateVersion;
      runtime.authority = authority;
      runtime.startedAt = new Date(this.#clock.now()).toISOString();
      runtime.settled = false;
      runtime.roundScored = false;
      runtime.series = {
        phase: 'playing',
        roundNumber: 1,
        multiplier: 1,
        multiplierReason: 'normal',
        participants: candidate.players.map((player) => ({
          playerId: player.playerId,
          score: 0,
          wins: 0,
          losses: 0,
          longestStreak: 0,
          currentStreak: 0,
          titles: [],
        })),
        continueVotes: candidate.players.map((player) => ({
          playerId: player.playerId,
          choice: 'pending',
        })),
        finishOrder: [],
      };
      runtime.roundFinishOrder = [];
      runtime.originalTeams =
        players.length === 4
          ? [
              [players[0]!, players[2]!],
              [players[1]!, players[3]!],
            ]
          : [];
      this.#scheduleTurn(runtime);
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    if (event.type === 'game.action') {
      if (!runtime.authority)
        throw new RoomServiceError('INVALID_INPUT', '游戏尚未开始');
      const consumesTurn = event.action.kind !== 'exchange-trump-two';
      const previousAuthority = runtime.authority;
      runtime.authority = this.#applyAction(
        runtime.authority,
        identity.playerId,
        event.action,
      );
      runtime.authority = this.#continueRanking(runtime, runtime.authority);
      if (
        event.action.kind === 'pass' &&
        previousAuthority.state.table.length > 0 &&
        runtime.authority.state.table.length === 0
      ) {
        const defender = previousAuthority.state.defender;
        runtime.defenseWins.set(
          defender,
          (runtime.defenseWins.get(defender) ?? 0) + 1,
        );
      }
      runtime.stateVersion += 1;
      if (consumesTurn) this.#scheduleTurn(runtime);
      else if (runtime.authority.state.phase === 'finished')
        this.#cancelTimer(runtime);
      await this.#settleIfFinished(runtime);
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    if (event.type === 'series.exit') {
      if (!runtime.series || runtime.series.phase === 'series-result')
        throw new RoomServiceError('INVALID_INPUT', '房间赛已经结束');
      await this.#forfeitSeries(runtime, identity.playerId);
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    if (event.type === 'series.continue') {
      if (!runtime.series || runtime.series.phase !== 'continue-vote')
        throw new RoomServiceError('INVALID_INPUT', '当前不在继续投票阶段');
      const vote = runtime.series.continueVotes.find(
        (item) => item.playerId === identity.playerId,
      );
      if (!vote) throw new RoomServiceError('UNAUTHORIZED', '玩家不属于本场');
      const continueVotes = runtime.series.continueVotes.map((item) =>
        item.playerId === identity.playerId
          ? {
              ...item,
              choice: event.continue
                ? ('continue' as const)
                : ('stop' as const),
            }
          : item,
      );
      if (!event.continue) {
        runtime.series = this.#withHonors(
          runtime,
          finalizeSeries({ ...runtime.series, continueVotes }),
        );
        await this.#history.saveSeries?.({
          seriesId: `series-${runtime.snapshot.roomId}`,
          roomId: runtime.snapshot.roomId,
          endedAt: new Date(this.#clock.now()).toISOString(),
          summary: runtime.series,
        });
      } else if (continueVotes.every((item) => item.choice === 'continue')) {
        const roundNumber = runtime.series.roundNumber + 1;
        const streak = runtime.series.participants.some(
          (item) => item.currentStreak >= 2,
        );
        const { multiplier, multiplierReason } = chooseRoundMultiplier(
          roundNumber,
          streak,
          this.#random,
        );
        const players = [...runtime.snapshot.players]
          .sort((a, b) => a.seat - b.seat)
          .map((player) => player.playerId);
        runtime.authority = this.#newAuthority(players);
        runtime.series = {
          ...runtime.series,
          phase: 'playing',
          roundNumber,
          multiplier,
          multiplierReason,
          participants: runtime.series.participants.map((item) =>
            item.currentStreak >= 2 ? { ...item, currentStreak: 0 } : item,
          ),
          continueVotes: players.map((playerId) => ({
            playerId,
            choice: 'pending' as const,
          })),
          finishOrder: [],
        };
        runtime.startedAt = new Date(this.#clock.now()).toISOString();
        runtime.settled = false;
        runtime.roundScored = false;
        runtime.roundFinishOrder = [];
        this.#scheduleTurn(runtime);
      } else {
        runtime.series = { ...runtime.series, continueVotes };
      }
      runtime.stateVersion += 1;
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    throw new RoomServiceError('INVALID_INPUT', '不支持的操作');
  }

  #newAuthority(players: readonly PlayerId[]): AuthorityState {
    const deal = createInitialDeal(players, this.#random);
    return players.length === 2
      ? {
          mode: 2,
          state: createTwoPlayerState(deal, players),
          attackOwners: [],
        }
      : players.length === 3
        ? {
            mode: 3,
            state: createThreePlayerState(deal, players),
            attackOwners: [],
          }
        : {
            mode: 4,
            state: createFourPlayerState(deal, players),
            attackOwners: [],
          };
  }

  #continueRanking(
    room: RealtimeRoom,
    authority: AuthorityState,
  ): AuthorityState {
    if (authority.state.phase !== 'finished') return authority;
    if (authority.state.result.reason !== 'emptied-hand') return authority;
    if (authority.mode === 2) {
      for (const player of [
        authority.state.result.winner,
        authority.state.result.loser,
      ])
        if (!room.roundFinishOrder.includes(player))
          room.roundFinishOrder.push(player);
      if (room.series)
        room.series = {
          ...room.series,
          finishOrder: [...room.roundFinishOrder],
        };
      return authority;
    }
    const finisher =
      authority.mode === 4
        ? authority.state.result.triggerPlayer
        : authority.state.result.outcome === 'winner'
          ? authority.state.result.winner
          : undefined;
    if (!finisher) return authority;
    if (!room.roundFinishOrder.includes(finisher))
      room.roundFinishOrder.push(finisher);
    if (room.series)
      room.series = { ...room.series, finishOrder: [...room.roundFinishOrder] };
    const previous = authority.state;
    const remaining = previous.players.filter((player) => player !== finisher);
    const stock = [...previous.stock];
    const hands = new Map(
      remaining.map((player) => [player, [...previous.hands.get(player)!]]),
    );
    const start = previous.players.indexOf(finisher);
    const order = Array.from(
      { length: previous.players.length - 1 },
      (_, offset) =>
        previous.players[(start + offset + 1) % previous.players.length]!,
    ).filter((player) => player !== finisher);
    for (const player of order) {
      const hand = hands.get(player)!;
      while (hand.length < 8 && stock.length) hand.push(stock.shift()!);
    }
    const discard = [
      ...previous.discard,
      ...previous.table.flatMap((pair) =>
        pair.defense ? [pair.attack, pair.defense] : [pair.attack],
      ),
    ];
    const roundAttacker = order[0]!;
    const defender = order[1]!;
    const common = {
      hands,
      stock,
      discard,
      trumpSuit: previous.trumpSuit,
      bottomCard: stock.at(-1) ?? null,
      table: [],
      leadRanks: new Set(),
      attackCount: 0,
      roundAttackLimit: hands.get(defender)!.length,
      indicatorExchanged: previous.indicatorExchanged,
      version: previous.version + 1,
      phase: 'awaiting-attack' as const,
      actor: roundAttacker,
      result: null,
    };
    if (remaining.length === 3) {
      return {
        mode: 3,
        attackOwners: [],
        state: {
          ...common,
          players: remaining as unknown as readonly [
            PlayerId,
            PlayerId,
            PlayerId,
          ],
          roundAttacker,
          defender,
          attackCursor: roundAttacker,
          consecutivePasses: 0,
        } as ThreePlayerState<PlayerId>,
      };
    }
    return {
      mode: 2,
      attackOwners: [],
      state: {
        ...common,
        players: remaining as unknown as readonly [PlayerId, PlayerId],
        attacker: roundAttacker,
        defender,
      } as TwoPlayerState<PlayerId>,
    };
  }

  async #forfeitSeries(room: RealtimeRoom, playerId: PlayerId) {
    if (
      !room.series ||
      !room.authority ||
      room.series.phase === 'series-result'
    )
      return;
    const losers = new Set<PlayerId>();
    const winners = new Set<PlayerId>();
    if (room.snapshot.config.playerCount === 4) {
      const outcome = resolveFourPlayerTeamOutcome(
        room.series.participants.map((item) => item.playerId),
        room.originalTeams,
        new Set([playerId]),
      );
      for (const member of outcome.losers) losers.add(member);
      for (const member of outcome.winners) winners.add(member);
    } else {
      losers.add(playerId);
      for (const player of room.authority.state.players)
        if (player !== playerId) winners.add(player);
    }
    room.series = this.#withHonors(
      room,
      finalizeSeries(
        scoreSeriesRound(
          room.series,
          room.snapshot.config.playerCount,
          winners,
          losers,
        ),
      ),
    );
    room.roundScored = true;
    room.stateVersion += 1;
    this.#cancelTimer(room);
    for (const handle of room.disconnectForfeits.values())
      this.#clock.cancel(handle);
    room.disconnectForfeits.clear();
    await this.#history.saveSeries?.({
      seriesId: `series-${room.snapshot.roomId}`,
      roomId: room.snapshot.roomId,
      endedAt: new Date(this.#clock.now()).toISOString(),
      summary: room.series,
    });
    this.#broadcast(room);
  }

  #applyAction(
    authority: AuthorityState,
    playerId: PlayerId,
    action: Extract<ClientEvent, { type: 'game.action' }>['action'],
  ): AuthorityState {
    if (action.kind === 'beat-card') {
      const unresolved = authority.state.table.at(-1);
      if (
        !unresolved ||
        unresolved.defense ||
        unresolved.attack.id !== action.targetCardId
      )
        throw new ProtocolFailure(
          'ILLEGAL_ACTION',
          '防守目标与当前待防守牌不一致',
        );
    }
    const mapped =
      action.kind === 'play-card'
        ? { type: 'attack' as const, playerId, cardId: action.cardId }
        : action.kind === 'beat-card'
          ? { type: 'defend' as const, playerId, cardId: action.cardId }
          : action.kind === 'collect'
            ? { type: 'take' as const, playerId }
            : { type: action.kind, playerId };
    const owners =
      action.kind === 'play-card'
        ? [...authority.attackOwners, playerId]
        : authority.attackOwners;
    if (authority.mode === 2) {
      const state = applyTwoPlayerAction(
        authority.state,
        mapped as TwoPlayerAction<PlayerId>,
      );
      return {
        mode: 2,
        state,
        attackOwners: state.table.length === 0 ? [] : owners,
      };
    }
    if (authority.mode === 3) {
      const state = applyThreePlayerAction(
        authority.state,
        mapped as ThreePlayerAction<PlayerId>,
      );
      return {
        mode: 3,
        state,
        attackOwners: state.table.length === 0 ? [] : owners,
      };
    }
    const state = applyFourPlayerAction(
      authority.state,
      mapped as FourPlayerAction<PlayerId>,
    );
    return {
      mode: 4,
      state,
      attackOwners: state.table.length === 0 ? [] : owners,
    };
  }

  #broadcast(room: RealtimeRoom, except?: WebSocket) {
    for (const socket of room.sockets) {
      const identity = this.#connections.get(socket)?.identity;
      if (!identity || socket.readyState !== WebSocket.OPEN) continue;
      if (socket !== except)
        this.#send(socket, this.#identityState(room, identity));
    }
  }

  #identityState(
    room: RealtimeRoom,
    identity: Identity,
  ): IndividualServerEvent {
    if (identity.kind === 'player')
      return this.#playerState(room, identity.playerId);
    return {
      type: 'state.spectator',
      protocolVersion: PROTOCOL_VERSION,
      stateVersion: room.stateVersion,
      view: projectSpectatorView(
        room.snapshot,
        room.stateVersion,
        room.authority,
        room.turnDeadline,
        room.series,
      ),
    };
  }

  #broadcastEvent(room: RealtimeRoom, event: ServerEvent) {
    for (const socket of room.sockets)
      if (socket.readyState === WebSocket.OPEN) this.#send(socket, event);
  }

  #syncSpectators(room: RealtimeRoom) {
    room.snapshot = {
      ...room.snapshot,
      spectators: [...room.spectators.values()].map((item) => ({
        identity: 'spectator' as const,
        spectatorId: item.spectatorId,
        nickname: item.nickname,
        avatarId: item.avatarId,
        connection: item.connection,
      })),
    };
  }

  #digest(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  #playerState(room: RealtimeRoom, playerId: PlayerId): IndividualServerEvent {
    return {
      type: 'state.player',
      protocolVersion: PROTOCOL_VERSION,
      stateVersion: room.stateVersion,
      view: projectPlayerView(
        room.snapshot,
        room.stateVersion,
        playerId,
        room.authority,
        room.turnDeadline,
        room.series,
      ),
    };
  }

  #identityKey(identity: Identity) {
    return identity.kind === 'player'
      ? `${identity.roomId}:player:${identity.playerId}`
      : `${identity.roomId}:spectator:${identity.spectatorId}`;
  }

  async #settleIfFinished(room: RealtimeRoom) {
    if (
      room.settled ||
      room.settling ||
      !room.authority ||
      room.authority.state.phase !== 'finished'
    )
      return;
    room.settling = true;
    this.#scoreFinishedRound(room);
    const game = projectSpectatorView(
      room.snapshot,
      room.stateVersion,
      room.authority,
      null,
      room.series,
    ).public.game!;
    const winners = new Set(
      room.roundFinishOrder.length === room.snapshot.config.playerCount
        ? [room.roundFinishOrder[0]!]
        : (game.winnerPlayerIds ?? []),
    );
    const losers = new Set(
      room.roundFinishOrder.length === room.snapshot.config.playerCount
        ? [room.roundFinishOrder.at(-1)!]
        : (game.loserPlayerIds ?? []),
    );
    const record: GameRecord = {
      gameId: game.gameId,
      roomName: room.snapshot.name,
      playerCount: room.snapshot.config.playerCount,
      startedAt: room.startedAt ?? new Date(this.#clock.now()).toISOString(),
      endedAt: new Date(this.#clock.now()).toISOString(),
      reason: game.resultReason!,
      participants: room.snapshot.players.map((player) => {
        const publicGamePlayer = game.players.find(
          (item) => item.playerId === player.playerId,
        )!;
        return {
          playerId: player.playerId,
          nickname: player.nickname,
          seat: player.seat,
          team: publicGamePlayer.team,
          outcome: settlementOutcome(
            room.snapshot.config.playerCount,
            player.playerId,
            winners,
            losers,
          ),
        };
      }),
    };
    try {
      await this.#history.saveGame({
        record,
        visitorByPlayer: Object.fromEntries(room.visitorByPlayer),
      });
      room.settled = true;
    } catch {
      // The finished authority remains intact; a later duplicate finish/query may retry persistence.
    } finally {
      room.settling = false;
    }
  }

  #scoreFinishedRound(room: RealtimeRoom) {
    if (room.roundScored || !room.series || !room.authority) return;
    const game = projectSpectatorView(
      room.snapshot,
      room.stateVersion,
      room.authority,
      null,
      room.series,
    ).public.game!;
    const explicitWinners = new Set(game.winnerPlayerIds ?? []);
    const losers = new Set(game.loserPlayerIds ?? []);
    if (
      room.snapshot.config.playerCount === 4 &&
      room.roundFinishOrder.length > 0 &&
      losers.size > 0
    ) {
      const outcome = resolveFourPlayerTeamOutcome(
        room.series.participants.map((item) => item.playerId),
        room.originalTeams,
        losers,
      );
      losers.clear();
      explicitWinners.clear();
      for (const player of outcome.losers) losers.add(player);
      for (const player of outcome.winners) explicitWinners.add(player);
    }
    if (room.authority.mode === 2 && explicitWinners.size === 1) {
      for (const item of game.players)
        if (!explicitWinners.has(item.playerId)) losers.add(item.playerId);
    }
    if (
      room.authority.mode === 3 &&
      explicitWinners.size === 0 &&
      losers.size === 1
    ) {
      for (const item of game.players)
        if (!losers.has(item.playerId)) explicitWinners.add(item.playerId);
    }
    const ranked =
      room.roundFinishOrder.length === room.snapshot.config.playerCount;
    const honorWinners = ranked
      ? new Set([room.roundFinishOrder[0]!])
      : explicitWinners;
    const elapsed = Math.max(
      0,
      this.#clock.now() -
        Date.parse(room.startedAt ?? new Date(this.#clock.now()).toISOString()),
    );
    if (room.fastestWinMs === undefined || elapsed < room.fastestWinMs) {
      room.fastestWinMs = elapsed;
      room.fastestWinners = new Set(honorWinners);
    } else if (elapsed === room.fastestWinMs) {
      for (const winner of honorWinners) room.fastestWinners.add(winner);
    }
    room.series = ranked
      ? scoreRankedRound(
          room.series,
          room.snapshot.config.playerCount,
          room.roundFinishOrder,
          room.originalTeams,
        )
      : scoreSeriesRound(
          room.series,
          room.snapshot.config.playerCount,
          explicitWinners,
          losers,
        );
    room.roundScored = true;
  }

  #withHonors(room: RealtimeRoom, series: RoomSeries): RoomSeries {
    const bestDefense = Math.max(0, ...room.defenseWins.values());
    return {
      ...series,
      participants: series.participants.map((item) => ({
        ...item,
        titles: [
          ...item.titles,
          ...(room.fastestWinners.has(item.playerId)
            ? (['快刀手'] as const)
            : []),
          ...(bestDefense > 0 &&
          (room.defenseWins.get(item.playerId) ?? 0) === bestDefense
            ? (['滴水不漏'] as const)
            : []),
        ],
      })),
    };
  }

  #cancelTimer(room: RealtimeRoom) {
    room.timerGeneration += 1;
    if (room.timerHandle !== undefined) this.#clock.cancel(room.timerHandle);
    room.timerHandle = undefined;
    room.turnDeadline = null;
  }

  #scheduleTurn(room: RealtimeRoom) {
    if (!room.authority || room.authority.state.phase === 'finished') {
      this.#cancelTimer(room);
      return;
    }
    if (room.timerHandle !== undefined) this.#clock.cancel(room.timerHandle);
    const generation = ++room.timerGeneration;
    const delay = room.snapshot.config.turnTimeoutSeconds * 1000;
    room.turnDeadline = new Date(this.#clock.now() + delay).toISOString();
    room.timerHandle = this.#clock.schedule(delay, () => {
      if (room.timerGeneration !== generation || !room.authority) return;
      const state = room.authority.state;
      if (state.phase === 'finished') return this.#cancelTimer(room);
      try {
        const timedAction =
          state.phase === 'awaiting-defense'
            ? ({ kind: 'collect' } as const)
            : state.table.length > 0
              ? ({ kind: 'pass' } as const)
              : (() => {
                  const card = [...state.hands.get(state.actor)!]
                    .filter((item) => item.kind === 'standard')
                    .sort((left, right) => {
                      if (left.kind !== 'standard' || right.kind !== 'standard')
                        return 0;
                      return (
                        timeoutRankOrder.indexOf(left.rank) -
                          timeoutRankOrder.indexOf(right.rank) ||
                        timeoutSuitOrder.indexOf(left.suit) -
                          timeoutSuitOrder.indexOf(right.suit) ||
                        left.id.localeCompare(right.id)
                      );
                    })[0];
                  if (!card) throw new Error('No legal opening card');
                  return { kind: 'play-card' as const, cardId: card.id };
                })();
        const previousTableLength = state.table.length;
        const previousDefender = state.defender;
        room.authority = this.#applyAction(
          room.authority,
          state.phase === 'awaiting-defense' ? state.defender : state.actor,
          timedAction,
        );
        room.authority = this.#continueRanking(room, room.authority);
        if (
          timedAction.kind === 'pass' &&
          previousTableLength > 0 &&
          room.authority.state.table.length === 0
        )
          room.defenseWins.set(
            previousDefender,
            (room.defenseWins.get(previousDefender) ?? 0) + 1,
          );
        room.stateVersion += 1;
        this.#scheduleTurn(room);
        void this.#settleIfFinished(room);
        this.#broadcast(room);
      } catch {
        this.#cancelTimer(room);
      }
    });
  }

  #send(socket: WebSocket, event: ServerEvent) {
    const safe = serverEventSchema.parse(event);
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(safe));
  }
}
