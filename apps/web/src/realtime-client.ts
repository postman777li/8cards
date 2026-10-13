import {
  PROTOCOL_VERSION,
  parseClientEvent,
  safeParseServerEvent,
  type ClientEvent,
  type GameAction,
  type PlayerId,
  type PlayerView,
  type ProtocolError,
  type RoomId,
} from '@8cards/shared';
import type { StoredSession } from './lobby.js';

export type LobbyRequest =
  | {
      kind: 'create';
      nickname: string;
      roomName: string;
      playerCount: 2 | 3 | 4;
    }
  | { kind: 'join'; nickname: string; roomCode: string };
type Options = {
  url: string;
  createSocket?: (url: string) => WebSocket;
  timeoutMs?: number;
};

export interface LobbyConnection {
  roomId: RoomId;
  playerId: PlayerId;
  reconnectToken: string;
  view: PlayerView;
  socket: WebSocket;
  ready(value: boolean): Promise<void>;
  start(): Promise<void>;
  leave(): Promise<void>;
  action(value: GameAction): Promise<void>;
  subscribe(listener: (view: PlayerView) => void): () => void;
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

class LiveConnection implements LobbyConnection {
  #sequence = 2;
  #pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  #views = new Set<(view: PlayerView) => void>();
  #closes = new Set<() => void>();
  #closed = false;
  constructor(
    readonly roomId: RoomId,
    readonly playerId: PlayerId,
    public reconnectToken: string,
    public view: PlayerView,
    readonly socket: WebSocket,
  ) {
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
  action(value: GameAction) {
    return this.#send('game.action', { action: value });
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
    type: 'room.ready' | 'room.start' | 'room.leave' | 'game.action',
    body: { ready?: boolean; action?: GameAction },
  ) {
    if (this.#closed || this.#pending.size)
      return Promise.reject(new LobbyConnectionError('操作正在处理中'));
    const id = requestId();
    const event = parseClientEvent({
      type,
      protocolVersion: PROTOCOL_VERSION,
      requestId: id,
      actionSequence: this.#sequence++,
      expectedStateVersion: this.view.public.stateVersion,
      ...body,
    });
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
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
          view,
          socket,
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
            roomName: request.roomName,
            config: {
              playerCount: request.playerCount,
              allowSpectators: true,
              allowChat: true,
              turnTimeoutSeconds: 20,
            },
          }
        : {
            type: 'room.join',
            ...base,
            nickname: request.nickname,
            roomCode: request.roomCode,
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
      ...session,
    }),
    options,
  );
}
