import { randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  PROTOCOL_VERSION,
  individualServerEventSchema,
  requestIdSchema,
  safeParseClientEvent,
  type ClientEvent,
  type ErrorCode,
  type IndividualServerEvent,
  type PlayerId,
  type RequestId,
  type RoomId,
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

import { projectPlayerView, type AuthorityState } from './projection.js';
import {
  RoomService,
  RoomServiceError,
  type PlayerSession,
  type RoomSnapshot,
} from './room-service.js';

const CACHE_LIMIT = 64;
export const MAX_MESSAGE_BYTES = 16 * 1024;

interface Identity {
  roomId: RoomId;
  playerId: PlayerId;
  reconnectToken: string;
}
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
}
interface RealtimeRoom {
  snapshot: RoomSnapshot;
  stateVersion: number;
  authority?: AuthorityState;
  sockets: Set<WebSocket>;
  turnDeadline: string | null;
  timerGeneration: number;
  timerHandle?: unknown;
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
  readonly #connections = new Map<WebSocket, ConnectionState>();
  readonly #rooms = new Map<RoomId, RealtimeRoom>();
  readonly #currentSockets = new Map<string, WebSocket>();
  #closing = false;

  constructor(options: RealtimeOptions = {}) {
    this.#roomService = options.roomService ?? new RoomService();
    this.#random = options.random ?? secureRandom;
    this.#clock = options.clock ?? systemClock;
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
  }

  #connect(socket: WebSocket) {
    this.#connections.set(socket, {
      nextSequence: 1,
      bySequence: new Map(),
      sequenceByRequestId: new Map(),
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
          try {
            room.snapshot = this.#roomService.markDisconnected({
              ...state.identity,
              expectedStateVersion: room.snapshot.stateVersion,
            });
            room.stateVersion += 1;
            this.#broadcast(room);
          } catch {
            // A concurrent restore or room removal already superseded this close.
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
      });
    if (event.type === 'session.resume' && changedRoom && connection.identity)
      responses.push(
        this.#playerState(changedRoom, connection.identity.playerId),
      );
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
        event.type === 'session.resume' ? socket : undefined,
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
        roomId: session.room.roomId,
        playerId: session.playerId,
        reconnectToken: session.reconnectToken,
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
      };
      runtime.snapshot = session.room;
      runtime.stateVersion = session.stateVersion;
      runtime.sockets.add(socket);
      this.#rooms.set(session.room.roomId, runtime);
      connection.identity = {
        roomId: session.room.roomId,
        playerId: session.playerId,
        reconnectToken: session.reconnectToken,
      };
      this.#currentSockets.set(this.#identityKey(connection.identity), socket);
      return {
        stateVersion: runtime.stateVersion,
        credential: session,
        changedRoom: runtime,
      };
    }
    if (!connection.identity)
      throw new RoomServiceError('UNAUTHORIZED', '连接尚未绑定玩家身份');
    if (
      event.type === 'chat.send' ||
      event.type === 'spectate.join' ||
      event.type === 'spectate.leave'
    )
      throw new RoomServiceError('INVALID_INPUT', '此功能尚未实现');
    const identity = connection.identity;
    const runtime = this.#rooms.get(identity.roomId);
    if (!runtime) throw new RoomServiceError('ROOM_NOT_FOUND', '房间不存在');
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
        this.#send(socket, this.#playerState(room, identity.playerId));
    }
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

  #identityKey(identity: Pick<Identity, 'roomId' | 'playerId'>) {
    return `${identity.roomId}:${identity.playerId}`;
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
    const expectedVersion = room.stateVersion;
    const delay = room.snapshot.config.turnTimeoutSeconds * 1000;
    room.turnDeadline = new Date(this.#clock.now() + delay).toISOString();
    room.timerHandle = this.#clock.schedule(delay, () => {
      if (
        room.timerGeneration !== generation ||
        room.stateVersion !== expectedVersion ||
        !room.authority
      )
        return;
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
        this.#broadcast(room);
      } catch {
        this.#cancelTimer(room);
      }
    });
  }

  #send(socket: WebSocket, event: IndividualServerEvent) {
    const safe = individualServerEventSchema.parse(event);
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(safe));
  }
}
