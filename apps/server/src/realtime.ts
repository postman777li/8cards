import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  PROTOCOL_VERSION,
  serverEventSchema,
  requestIdSchema,
  safeParseClientEvent,
  type ClientEvent,
  type ErrorCode,
  type IndividualServerEvent,
  type PlayerId,
  type RequestId,
  type RoomId,
  type SpectatorId,
  type VisitorId,
  type ChatMessage,
  type ServerEvent,
  type GameRecord,
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
}
interface SpectatorRecord {
  spectatorId: SpectatorId;
  nickname: string;
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
  visitorByPlayer: Map<PlayerId, VisitorId>;
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
}

const systemClock: RealtimeClock = {
  now: () => Date.now(),
  schedule: (delay, callback) => setTimeout(callback, delay),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const secureRandom = () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000;
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
  readonly #connections = new Map<WebSocket, ConnectionState>();
  readonly #rooms = new Map<RoomId, RealtimeRoom>();
  readonly #currentSockets = new Map<string, WebSocket>();
  #closing = false;

  constructor(options: RealtimeOptions = {}) {
    this.#roomService = options.roomService ?? new RoomService();
    this.#random = options.random ?? secureRandom;
    this.#clock = options.clock ?? systemClock;
    this.#history = options.historyStore ?? new SqliteHistoryStore();
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
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
      this.webSocketServer.emit('connection', webSocket, request),
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const room of this.#rooms.values()) this.#cancelTimer(room);
    for (const socket of this.webSocketServer.clients) socket.terminate();
    await new Promise<void>((resolve) =>
      this.webSocketServer.close(() => resolve()),
    );
    this.#history.close?.();
  }

  #connect(socket: WebSocket) {
    this.#connections.set(socket, {
      nextSequence: 1,
      bySequence: new Map(),
      sequenceByRequestId: new Map(),
      chatSentAt: [],
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text messages only');
        return;
      }
      this.#receive(socket, data.toString());
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

  #receive(socket: WebSocket, text: string) {
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
    this.#process(socket, parsed.data, canonicalize(parsed.data));
  }

  #process(socket: WebSocket, event: ClientEvent, canonical: string) {
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
      const result = this.#execute(socket, connection, event);
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
      (event.type === 'session.resume' || event.type === 'spectate.resume') &&
      changedRoom &&
      connection.identity
    )
      responses.push(this.#identityState(changedRoom, connection.identity));
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

  #execute(socket: WebSocket, connection: ConnectionState, event: ClientEvent) {
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
        visitorByPlayer: new Map(),
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
      this.#settleIfFinished(runtime);
      const history = this.#history.getVisitorHistory(identity.visitorId, 20);
      this.#send(socket, {
        type: 'history.result',
        protocolVersion: PROTOCOL_VERSION,
        ...history,
        ...(runtime.authority?.state.phase === 'finished'
          ? {
              persistenceStatus: runtime.settled
                ? ('saved' as const)
                : ('pending' as const),
            }
          : {}),
      });
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
      this.#scheduleTurn(runtime);
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    if (event.type === 'game.action') {
      if (!runtime.authority)
        throw new RoomServiceError('INVALID_INPUT', '游戏尚未开始');
      const consumesTurn = event.action.kind !== 'exchange-trump-two';
      runtime.authority = this.#applyAction(
        runtime.authority,
        identity.playerId,
        event.action,
      );
      runtime.stateVersion += 1;
      if (consumesTurn) this.#scheduleTurn(runtime);
      else if (runtime.authority.state.phase === 'finished')
        this.#cancelTimer(runtime);
      this.#settleIfFinished(runtime);
      return { stateVersion: runtime.stateVersion, changedRoom: runtime };
    }
    throw new RoomServiceError('INVALID_INPUT', '不支持的操作');
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
      ),
    };
  }

  #identityKey(identity: Identity) {
    return identity.kind === 'player'
      ? `${identity.roomId}:player:${identity.playerId}`
      : `${identity.roomId}:spectator:${identity.spectatorId}`;
  }

  #settleIfFinished(room: RealtimeRoom) {
    if (
      room.settled ||
      !room.authority ||
      room.authority.state.phase !== 'finished'
    )
      return;
    const game = projectSpectatorView(
      room.snapshot,
      room.stateVersion,
      room.authority,
      null,
    ).public.game!;
    const winners = new Set(game.winnerPlayerIds ?? []);
    const losers = new Set(game.loserPlayerIds ?? []);
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
      this.#history.saveGame({
        record,
        visitorByPlayer: Object.fromEntries(room.visitorByPlayer),
      });
      room.settled = true;
    } catch {
      // The finished authority remains intact; a later duplicate finish/query may retry persistence.
    }
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
        room.authority = this.#applyAction(
          room.authority,
          state.phase === 'awaiting-defense' ? state.defender : state.actor,
          { kind: state.phase === 'awaiting-defense' ? 'collect' : 'pass' },
        );
        room.stateVersion += 1;
        this.#scheduleTurn(room);
        this.#settleIfFinished(room);
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
