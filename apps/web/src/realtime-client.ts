import {
  PROTOCOL_VERSION,
  parseClientEvent,
  safeParseServerEvent,
  type ClientEvent,
  type PlayerId,
  type PlayerView,
  type ProtocolError,
  type RoomId,
} from '@8cards/shared';

export type LobbyRequest =
  | {
      kind: 'create';
      nickname: string;
      roomName: string;
      playerCount: 2 | 3 | 4;
    }
  | { kind: 'join'; nickname: string; roomCode: string };

export interface LobbyConnection {
  roomId: RoomId;
  playerId: PlayerId;
  reconnectToken: string;
  view: PlayerView;
  socket: WebSocket;
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
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
      throw new Error('VITE_WS_URL 必须使用 ws:// 或 wss://');
    return url.toString();
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV
    ? `${location.hostname}:3001`
    : location.host;
  return `${protocol}//${host}/ws`;
}

const createRequestId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `lobby-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function connectToLobby(
  request: LobbyRequest,
  options: {
    url: string;
    createSocket?: (url: string) => WebSocket;
    timeoutMs?: number;
  },
): { promise: Promise<LobbyConnection>; cancel: () => void } {
  const socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
    options.url,
  );
  const requestId = createRequestId();
  const event: ClientEvent =
    request.kind === 'create'
      ? {
          type: 'room.create',
          protocolVersion: PROTOCOL_VERSION,
          requestId: requestId as ClientEvent['requestId'],
          actionSequence: 1,
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
          protocolVersion: PROTOCOL_VERSION,
          requestId: requestId as ClientEvent['requestId'],
          actionSequence: 1,
          nickname: request.nickname,
          roomCode: request.roomCode,
        };
  parseClientEvent(event);

  let responseReceived = false;
  let credential:
    { roomId: RoomId; playerId: PlayerId; reconnectToken: string } | undefined;
  let view: PlayerView | undefined;
  let settled = false;
  let rejectPromise: (error: Error) => void = () => undefined;

  const cleanupFailure = () => {
    clearTimeout(timer);
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState < 2) socket.close();
  };

  const promise = new Promise<LobbyConnection>((resolve, reject) => {
    rejectPromise = reject;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupFailure();
      reject(error);
    };
    const complete = () => {
      if (settled || !responseReceived || !credential || !view) return;
      const room = view.public.room;
      if (
        view.viewerPlayerId !== credential.playerId ||
        room.roomId !== credential.roomId
      ) {
        fail(new LobbyConnectionError('服务器返回的身份状态不一致'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      resolve({ ...credential, view, socket });
    };
    socket.onopen = () => socket.send(JSON.stringify(event));
    socket.onerror = () =>
      fail(new LobbyConnectionError('无法连接房间服务，请检查网络后重试'));
    socket.onclose = () => fail(new LobbyConnectionError('连接已中断，请重试'));
    socket.onmessage = (message) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(message.data));
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
      if (
        item.type === 'response.error' &&
        item.requestId === event.requestId
      ) {
        fail(new LobbyConnectionError(item.error.message, item.error));
        return;
      }
      if (item.type === 'response.ok' && item.requestId === event.requestId)
        responseReceived = true;
      else if (item.type === 'session.established') credential = item;
      else if (item.type === 'state.player') view = item.view;
      complete();
    };
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanupFailure();
    rejectPromise(new LobbyConnectionError('连接超时，请重试'));
  }, options.timeoutMs ?? 10_000);

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanupFailure();
      rejectPromise(new LobbyConnectionError('操作已取消'));
    },
  };
}
