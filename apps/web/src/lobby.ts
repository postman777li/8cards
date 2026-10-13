import {
  nicknameSchema,
  roomCodeSchema,
  roomNameSchema,
  type PlayerId,
  type RoomId,
} from '@8cards/shared';

export const NICKNAME_STORAGE_KEY = '8cards:lobby:nickname';
export const SETTINGS_STORAGE_KEY = '8cards:lobby:settings';
const SESSION_STORAGE_PREFIX = '8cards:session:';
const CURRENT_SESSION_STORAGE_KEY = '8cards:session:current';

export interface LobbySettings {
  soundEffects: boolean;
  backgroundMusic: boolean;
  reducedMotion: boolean;
}

export interface StoredSession {
  roomId: RoomId;
  playerId: PlayerId;
  reconnectToken: string;
}

export const defaultSettings: LobbySettings = {
  soundEffects: true,
  backgroundMusic: false,
  reducedMotion: false,
};

export function normalizeNickname(value: string): string {
  return value.trim();
}

export function normalizeRoomName(value: string): string {
  return value.trim();
}

export function normalizeRoomCode(value: string): string {
  return value.trim().toUpperCase();
}

export function validateNickname(value: string): string | null {
  return nicknameSchema.safeParse(normalizeNickname(value)).success
    ? null
    : '请输入 1–24 个字符的昵称';
}

export function validateRoomName(value: string): string | null {
  return roomNameSchema.safeParse(normalizeRoomName(value)).success
    ? null
    : '请输入 1–40 个字符的房间名称';
}

export function validateRoomCode(value: string): string | null {
  return roomCodeSchema.safeParse(normalizeRoomCode(value)).success
    ? null
    : '房间码应为 6 位大写字母或数字';
}

export function roomCodeFromUrl(url: URL): string {
  const candidate = normalizeRoomCode(url.searchParams.get('room') ?? '');
  return roomCodeSchema.safeParse(candidate).success ? candidate : '';
}

export function buildShareUrl(url: URL, roomCode: string): string {
  const share = new URL(url.origin + url.pathname);
  share.searchParams.set('room', normalizeRoomCode(roomCode));
  return share.toString();
}

export function loadSettings(storage: Storage): LobbySettings {
  try {
    const value = JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null');
    if (
      value &&
      typeof value.soundEffects === 'boolean' &&
      typeof value.backgroundMusic === 'boolean' &&
      typeof value.reducedMotion === 'boolean'
    )
      return value as LobbySettings;
  } catch {
    // Corrupt preferences are safely replaced with defaults.
  }
  return defaultSettings;
}

export function saveSettings(storage: Storage, settings: LobbySettings): void {
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function saveSession(storage: Storage, session: StoredSession): void {
  const key = `${SESSION_STORAGE_PREFIX}${session.roomId}:${session.playerId}`;
  storage.setItem(
    key,
    JSON.stringify({
      roomId: session.roomId,
      playerId: session.playerId,
      reconnectToken: session.reconnectToken,
    } satisfies StoredSession),
  );
  storage.setItem(CURRENT_SESSION_STORAGE_KEY, key);
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.roomId === 'string' &&
    typeof candidate.playerId === 'string' &&
    typeof candidate.reconnectToken === 'string' &&
    candidate.reconnectToken.length >= 32
  );
}

export function loadCurrentSession(storage: Storage): StoredSession | null {
  const key = storage.getItem(CURRENT_SESSION_STORAGE_KEY);
  if (!key?.startsWith(SESSION_STORAGE_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    return isStoredSession(value)
      ? {
          roomId: value.roomId,
          playerId: value.playerId,
          reconnectToken: value.reconnectToken,
        }
      : null;
  } catch {
    return null;
  }
}

export function clearCurrentSession(storage: Storage): void {
  const key = storage.getItem(CURRENT_SESSION_STORAGE_KEY);
  if (key?.startsWith(SESSION_STORAGE_PREFIX)) storage.removeItem(key);
  storage.removeItem(CURRENT_SESSION_STORAGE_KEY);
}
