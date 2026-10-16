import {
  PROTOCOL_VERSION,
  parseClientEvent,
  safeParseServerEvent,
  type AvatarId,
  type ClientEvent,
  type GameAction,
  type PlayerId,
  type PlayerView,
  type ProtocolError,
  type RoomId,
  type VisitorId,
  type ChatMessage,
  type GameRecord,
  type SpectatorId,
  type SpectatorView,
  type ReactionEvent,
  type ReactionId,
} from '@8cards/shared';
import type { StoredSession } from './lobby.js';

export type LobbyRequest =
  | {
      kind: 'create';
      nickname: string;
      avatarId?: AvatarId;
      roomName: string;
      playerCount: 2 | 3 | 4;
      visitorId?: VisitorId;
    }
  | {
      kind: 'join';
      nickname: string;
      avatarId?: AvatarId;
      roomCode: string;
      visitorId?: VisitorId;
    };
type Options = {
  url: string;
  createSocket?: (url: string) => WebSocket;
  timeoutMs?: number;
};

export interface LobbyConnection {
  roomId: RoomId;
  playerId: PlayerId;
  reconnectToken: string;
  visitorId: VisitorId | undefined;
  view: PlayerView;
  socket: WebSocket;
  ready(value: boolean): Promise<void>;
  start(): Promise<void>;
  leave(): Promise<void>;
  requestSeat(targetSeat: 0 | 1 | 2 | 3): Promise<void>;
  respondSeat(seatRequestId: string, accept: boolean): Promise<void>;
  continueSeries(value: boolean): Promise<void>;
  exitSeries(): Promise<void>;
  action(value: GameAction): Promise<void>;
  chat(message: string): Promise<void>;
  reaction(reactionId: ReactionId): Promise<void>;
  history(): Promise<void>;
  subscribeChat(
    listener: (messages: readonly ChatMessage[]) => void,
  ): () => void;
  subscribeHistory(listener: (value: VisitorHistory) => void): () => void;
  subscribeReactions(listener: (value: ReactionEvent) => void): () => void;
  subscribe(listener: (view: PlayerView) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  close(): void;
}
export interface VisitorHistory {
  stats: { games: number; wins: number; losses: number; unresolved: number };
  recent: GameRecord[];
  persistenceStatus?: 'saved' | 'pending' | undefined;
}
export interface SpectatorConnection {
  roomId: RoomId;
  spectatorId: SpectatorId;
  reconnectToken: string;
  visitorId: VisitorId;
  view: SpectatorView;
  socket: WebSocket;
  chat(message: string): Promise<void>;
  reaction(reactionId: ReactionId): Promise<void>;
  history(): Promise<void>;
  leave(): Promise<void>;
  subscribe(listener: (view: SpectatorView) => void): () => void;
  subscribeChat(
    listener: (messages: readonly ChatMessage[]) => void,
  ): () => void;
  subscribeHistory(listener: (value: VisitorHistory) => void): () => void;
  subscribeReactions(listener: (value: ReactionEvent) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  close(): void;
}

export class LobbyConnectionError extends Error {
  constructor(
    message: string,
    readonly protocolError?: ProtocolError,
  ) {
    super(message);
  }
}

export function resolveWebSocketUrl(
  location: Pick<Location, 'protocol' | 'host' | 'hostname'>,
  configured?: string,
): string {
  if (configured) {
    const url = new URL(configured);
    if (!['ws:', 'wss:'].includes(url.protocol))
      throw new Error('VITE_WS_URL 必须使用 ws:// 或 wss://');
    return url.toString();
  }
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${import.meta.env.DEV ? `${location.hostname}:3001` : location.host}/ws`;
}

const requestId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const chatFromEvent = (
  event: Extract<
    import('@8cards/shared').ServerEvent,
    { type: 'chat.message' }
  >,
): ChatMessage => ({
  messageId: event.messageId,
  senderNickname: event.senderNickname,
  message: event.message,
  sentAt: event.sentAt,
  chatVersion: event.chatVersion,
  ...(event.senderPlayerId ? { senderPlayerId: event.senderPlayerId } : {}),
  ...(event.senderSpectatorId
    ? { senderSpectatorId: event.senderSpectatorId }
    : {}),
});

class LiveConnection implements LobbyConnection {
  #sequence = 2;
  #pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  #views = new Set<(view: PlayerView) => void>();
  #closes = new Set<() => void>();
  #chatListeners = new Set<(messages: readonly ChatMessage[]) => void>();
  #historyListeners = new Set<(value: VisitorHistory) => void>();
  #reactionListeners = new Set<(value: ReactionEvent) => void>();
  #messages: ChatMessage[] = [];
  #blockingPending = 0;
  #closed = false;
  constructor(
    readonly roomId: RoomId,
    readonly playerId: PlayerId,
    public reconnectToken: string,
    readonly visitorId: VisitorId | undefined,
    public view: PlayerView,
    readonly socket: WebSocket,
    initialMessages: readonly ChatMessage[] = [],
  ) {
    this.#messages = [...initialMessages];
    socket.onmessage = ({ data }) => this.#receive(data);
    socket.onerror = () => this.#disconnect();
    socket.onclose = () => this.#disconnect();
  }
  ready(value: boolean) {
    return this.#send('room.ready', { ready: value });
  }
  start() {
    return this.#send('room.start', {});
  }
  leave() {
    return this.#send('room.leave', {});
  }
  requestSeat(targetSeat: 0 | 1 | 2 | 3) {
    return this.#send('room.seat.request', { targetSeat });
  }
  respondSeat(seatRequestId: string, accept: boolean) {
    return this.#send('room.seat.respond', { seatRequestId, accept });
  }
  action(value: GameAction) {
    return this.#send('game.action', { action: value });
  }
  continueSeries(value: boolean) {
    return this.#send('series.continue', { continue: value });
  }
  exitSeries() {
    return this.#send('series.exit', {});
  }
  chat(message: string) {
    return this.#send('chat.send', { message }, false);
  }
  reaction(reactionId: ReactionId) {
    return this.#send('reaction.send', { reactionId }, false);
  }
  history() {
    return this.#send('history.get', {}, false);
  }
  subscribeChat(listener: (messages: readonly ChatMessage[]) => void) {
    this.#chatListeners.add(listener);
    listener(this.#messages);
    return () => this.#chatListeners.delete(listener);
  }
  subscribeHistory(listener: (value: VisitorHistory) => void) {
    this.#historyListeners.add(listener);
    return () => this.#historyListeners.delete(listener);
  }
  subscribeReactions(listener: (value: ReactionEvent) => void) {
    this.#reactionListeners.add(listener);
    return () => this.#reactionListeners.delete(listener);
  }
  subscribe(listener: (view: PlayerView) => void) {
    this.#views.add(listener);
    return () => this.#views.delete(listener);
  }
  onDisconnect(listener: () => void) {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clear(new LobbyConnectionError('连接已关闭'));
    this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
    if (this.socket.readyState < 2) this.socket.close();
  }
  #send(
    type:
      | 'room.ready'
      | 'room.start'
      | 'room.leave'
      | 'room.seat.request'
      | 'room.seat.respond'
      | 'game.action'
      | 'chat.send'
      | 'reaction.send'
      | 'history.get'
      | 'series.continue'
      | 'series.exit',
    body: {
      ready?: boolean;
      action?: GameAction;
      message?: string;
      reactionId?: ReactionId;
      targetSeat?: 0 | 1 | 2 | 3;
      seatRequestId?: string;
      accept?: boolean;
      continue?: boolean;
    },
    blocking = true,
  ) {
    if (this.#closed || (blocking && this.#blockingPending > 0))
      return Promise.reject(new LobbyConnectionError('操作正在处理中'));
    const id = requestId();
    const event = parseClientEvent({
      type,
      protocolVersion: PROTOCOL_VERSION,
      requestId: id,
      actionSequence: this.#sequence++,
      ...(type === 'history.get'
        ? {}
        : { expectedStateVersion: this.view.public.stateVersion }),
      ...body,
    });
    return new Promise<void>((resolve, reject) => {
      if (blocking) this.#blockingPending += 1;
      this.#pending.set(id, {
        resolve: () => {
          if (blocking) this.#blockingPending -= 1;
          resolve();
        },
        reject: (error) => {
          if (blocking) this.#blockingPending -= 1;
          reject(error);
        },
      });
      this.socket.send(JSON.stringify(event));
    });
  }
  #receive(data: unknown) {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      this.#fatal('服务器返回了无法识别的消息');
      return;
    }
    const parsed = safeParseServerEvent(raw);
    if (!parsed.success) {
      this.#fatal('服务器消息校验失败');
      return;
    }
    const event = parsed.data;
    if (event.type === 'chat.message') {
      if (!this.#messages.some((item) => item.messageId === event.messageId)) {
        const message = chatFromEvent(event);
        this.#messages = [...this.#messages, message]
          .sort((a, b) => a.chatVersion - b.chatVersion)
          .slice(-100);
        for (const listener of this.#chatListeners) listener(this.#messages);
      }
      return;
    }
    if (event.type === 'reaction.show') {
      for (const listener of this.#reactionListeners) listener(event);
      return;
    }
    if (event.type === 'chat.history') {
      this.#messages = [...event.messages].sort(
        (a, b) => a.chatVersion - b.chatVersion,
      );
      for (const listener of this.#chatListeners) listener(this.#messages);
      return;
    }
    if (event.type === 'history.result') {
      for (const listener of this.#historyListeners) listener(event);
      return;
    }
    if (event.type === 'state.player') {
      if (
        event.view.viewerPlayerId !== this.playerId ||
        event.view.public.room.roomId !== this.roomId
      ) {
        this.#fatal('服务器返回的身份状态不一致');
        return;
      }
      if (event.stateVersion >= this.view.public.stateVersion) {
        this.view = event.view;
        for (const listener of this.#views) listener(event.view);
      }
      return;
    }
    if (event.type !== 'response.ok' && event.type !== 'response.error') return;
    const pending = this.#pending.get(event.requestId);
    if (!pending) return;
    this.#pending.delete(event.requestId);
    if (event.type === 'response.ok') pending.resolve();
    else
      pending.reject(
        new LobbyConnectionError(event.error.message, event.error),
      );
  }
  #fatal(message: string) {
    this.#clear(new LobbyConnectionError(message));
    if (this.socket.readyState < 2) this.socket.close();
  }
  #disconnect() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clear(new LobbyConnectionError('连接已中断'));
    for (const listener of this.#closes) listener();
  }
  #clear(error: Error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function handshake(event: ClientEvent, options: Options) {
  const socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
    options.url,
  );
  let ok = false;
  let credential: StoredSession | undefined;
  let view: PlayerView | undefined;
  let messages: readonly ChatMessage[] = [];
  let settled = false;
  let rejectPromise: (error: Error) => void = () => undefined;
  const cleanup = (close: boolean) => {
    clearTimeout(timer);
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    if (close && socket.readyState < 2) socket.close();
  };
  const promise = new Promise<LobbyConnection>((resolve, reject) => {
    rejectPromise = reject;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup(true);
      reject(error);
    };
    const complete = () => {
      if (settled || !ok || !credential || !view) return;
      if (
        view.viewerPlayerId !== credential.playerId ||
        view.public.room.roomId !== credential.roomId
      ) {
        fail(new LobbyConnectionError('服务器返回的身份状态不一致'));
        return;
      }
      settled = true;
      cleanup(false);
      resolve(
        new LiveConnection(
          credential.roomId,
          credential.playerId,
          credential.reconnectToken,
          credential.visitorId,
          view,
          socket,
          messages,
        ),
      );
    };
    socket.onopen = () => socket.send(JSON.stringify(event));
    socket.onerror = () =>
      fail(new LobbyConnectionError('无法连接房间服务，请检查网络后重试'));
    socket.onclose = () => fail(new LobbyConnectionError('连接已中断，请重试'));
    socket.onmessage = ({ data }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        fail(new LobbyConnectionError('服务器返回了无法识别的消息'));
        return;
      }
      const parsed = safeParseServerEvent(raw);
      if (!parsed.success) {
        fail(new LobbyConnectionError('服务器消息校验失败'));
        return;
      }
      const item = parsed.data;
      if (item.type === 'response.error' && item.requestId === event.requestId)
        fail(new LobbyConnectionError(item.error.message, item.error));
      else if (
        item.type === 'response.ok' &&
        item.requestId === event.requestId
      )
        ok = true;
      else if (item.type === 'session.established') credential = item;
      else if (item.type === 'state.player') view = item.view;
      else if (item.type === 'chat.history') messages = item.messages;
      complete();
    };
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      cleanup(true);
      rejectPromise(new LobbyConnectionError('连接超时，请重试'));
    }
  }, options.timeoutMs ?? 10_000);
  return {
    promise,
    cancel: () => {
      if (!settled) {
        settled = true;
        cleanup(true);
        rejectPromise(new LobbyConnectionError('操作已取消'));
      }
    },
  };
}

export function connectToLobby(request: LobbyRequest, options: Options) {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId(),
    actionSequence: 1,
  };
  return handshake(
    parseClientEvent(
      request.kind === 'create'
        ? {
            type: 'room.create',
            ...base,
            nickname: request.nickname,
            avatarId: request.avatarId ?? 'default',
            roomName: request.roomName,
            config: {
              playerCount: request.playerCount,
              allowSpectators: true,
              allowChat: true,
              turnTimeoutSeconds: 20,
            },
            ...(request.visitorId ? { visitorId: request.visitorId } : {}),
          }
        : {
            type: 'room.join',
            ...base,
            nickname: request.nickname,
            avatarId: request.avatarId ?? 'default',
            roomCode: request.roomCode,
            ...(request.visitorId ? { visitorId: request.visitorId } : {}),
          },
    ),
    options,
  );
}

export function resumeLobby(session: StoredSession, options: Options) {
  return handshake(
    parseClientEvent({
      type: 'session.resume',
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(),
      actionSequence: 1,
      roomId: session.roomId,
      playerId: session.playerId,
      reconnectToken: session.reconnectToken,
    }),
    options,
  );
}

class LiveSpectator implements SpectatorConnection {
  #sequence = 2;
  #pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  #views = new Set<(view: SpectatorView) => void>();
  #chats = new Set<(messages: readonly ChatMessage[]) => void>();
  #histories = new Set<(value: VisitorHistory) => void>();
  #reactions = new Set<(value: ReactionEvent) => void>();
  #closes = new Set<() => void>();
  #messages: ChatMessage[] = [];
  #closed = false;
  #leavePromise?: Promise<void>;
  constructor(
    readonly roomId: RoomId,
    readonly spectatorId: SpectatorId,
    public reconnectToken: string,
    readonly visitorId: VisitorId,
    public view: SpectatorView,
    readonly socket: WebSocket,
    initialMessages: readonly ChatMessage[] = [],
  ) {
    this.#messages = [...initialMessages];
    socket.onmessage = ({ data }) => this.#receive(data);
    socket.onerror = socket.onclose = () => {
      if (this.#closed) return;
      this.#closed = true;
      this.#rejectPending(new LobbyConnectionError('连接已中断'));
      for (const listener of this.#closes) listener();
    };
  }
  chat(message: string) {
    return this.#send('chat.send', {
      message,
      expectedStateVersion: this.view.public.stateVersion,
    });
  }
  reaction(reactionId: ReactionId) {
    return this.#send('reaction.send', {
      reactionId,
      expectedStateVersion: this.view.public.stateVersion,
    });
  }
  history() {
    return this.#send('history.get', {});
  }
  leave() {
    if (this.#leavePromise) return this.#leavePromise;
    this.#leavePromise = this.#send('spectate.leave', {
      expectedStateVersion: this.view.public.stateVersion,
    });
    return this.#leavePromise;
  }
  subscribe(listener: (view: SpectatorView) => void) {
    this.#views.add(listener);
    return () => this.#views.delete(listener);
  }
  subscribeChat(listener: (messages: readonly ChatMessage[]) => void) {
    this.#chats.add(listener);
    listener(this.#messages);
    return () => this.#chats.delete(listener);
  }
  subscribeHistory(listener: (value: VisitorHistory) => void) {
    this.#histories.add(listener);
    return () => this.#histories.delete(listener);
  }
  subscribeReactions(listener: (value: ReactionEvent) => void) {
    this.#reactions.add(listener);
    return () => this.#reactions.delete(listener);
  }
  onDisconnect(listener: () => void) {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new LobbyConnectionError('连接已关闭'));
    if (this.socket.readyState < 2) this.socket.close();
  }
  #send(
    type: 'chat.send' | 'reaction.send' | 'history.get' | 'spectate.leave',
    body: Record<string, unknown>,
  ) {
    if (this.#closed)
      return Promise.reject(new LobbyConnectionError('连接已中断'));
    const id = requestId();
    const event = parseClientEvent({
      type,
      protocolVersion: PROTOCOL_VERSION,
      requestId: id,
      actionSequence: this.#sequence++,
      ...body,
    });
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(event));
    });
  }
  #rejectPending(error: Error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
  #receive(data: unknown) {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      this.close();
      return;
    }
    const parsed = safeParseServerEvent(raw);
    if (!parsed.success) {
      this.close();
      return;
    }
    const event = parsed.data;
    if (
      event.type === 'state.spectator' &&
      event.view.public.room.roomId === this.roomId &&
      event.stateVersion >= this.view.public.stateVersion
    ) {
      this.view = event.view;
      for (const listener of this.#views) listener(event.view);
      return;
    }
    if (event.type === 'chat.message') {
      if (!this.#messages.some((item) => item.messageId === event.messageId))
        this.#messages = [...this.#messages, chatFromEvent(event)]
          .sort((a, b) => a.chatVersion - b.chatVersion)
          .slice(-100);
      for (const listener of this.#chats) listener(this.#messages);
      return;
    }
    if (event.type === 'reaction.show') {
      for (const listener of this.#reactions) listener(event);
      return;
    }
    if (event.type === 'chat.history') {
      this.#messages = [...event.messages];
      for (const listener of this.#chats) listener(this.#messages);
      return;
    }
    if (event.type === 'history.result') {
      for (const listener of this.#histories) listener(event);
      return;
    }
    if (event.type === 'response.ok' || event.type === 'response.error') {
      const pending = this.#pending.get(event.requestId);
      if (!pending) return;
      this.#pending.delete(event.requestId);
      if (event.type === 'response.ok') pending.resolve();
      else
        pending.reject(
          new LobbyConnectionError(event.error.message, event.error),
        );
    }
  }
}

function spectatorHandshake(event: ClientEvent, options: Options) {
  const socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
    options.url,
  );
  let ok = false;
  let credential:
    | Extract<
        import('@8cards/shared').ServerEvent,
        { type: 'spectator.established' }
      >
    | undefined;
  let view: SpectatorView | undefined;
  let messages: readonly ChatMessage[] = [];
  let settled = false;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<SpectatorConnection>((resolve, reject) => {
    rejectPromise = reject;
    const complete = () => {
      if (!settled && ok && credential && view) {
        settled = true;
        clearTimeout(timer);
        socket.onopen =
          socket.onmessage =
          socket.onerror =
          socket.onclose =
            null;
        resolve(
          new LiveSpectator(
            credential.roomId,
            credential.spectatorId,
            credential.reconnectToken,
            credential.visitorId,
            view,
            socket,
            messages,
          ),
        );
      }
    };
    socket.onopen = () => socket.send(JSON.stringify(event));
    socket.onerror = socket.onclose = () => {
      if (!settled) reject(new LobbyConnectionError('观战连接中断'));
    };
    socket.onmessage = ({ data }) => {
      const parsed = safeParseServerEvent(JSON.parse(String(data)));
      if (!parsed.success) return;
      const item = parsed.data;
      if (item.type === 'response.error' && item.requestId === event.requestId)
        reject(new LobbyConnectionError(item.error.message, item.error));
      else if (
        item.type === 'response.ok' &&
        item.requestId === event.requestId
      )
        ok = true;
      else if (item.type === 'spectator.established') credential = item;
      else if (item.type === 'state.spectator') view = item.view;
      else if (item.type === 'chat.history') messages = item.messages;
      complete();
    };
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      socket.close();
      rejectPromise(new LobbyConnectionError('观战连接超时'));
    }
  }, options.timeoutMs ?? 10_000);
  return {
    promise,
    cancel: () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.close();
        rejectPromise(new LobbyConnectionError('操作已取消'));
      }
    },
  };
}

export function spectateRoom(
  input: {
    nickname: string;
    avatarId?: AvatarId;
    roomCode: string;
    visitorId: VisitorId;
  },
  options: Options,
) {
  return spectatorHandshake(
    parseClientEvent({
      type: 'spectate.join',
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(),
      actionSequence: 1,
      ...input,
    }),
    options,
  );
}
export function resumeSpectator(
  input: {
    roomId: RoomId;
    spectatorId: SpectatorId;
    reconnectToken: string;
    visitorId: VisitorId;
  },
  options: Options,
) {
  return spectatorHandshake(
    parseClientEvent({
      type: 'spectate.resume',
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(),
      actionSequence: 1,
      ...input,
    }),
    options,
  );
}
