import { describe, expect, it } from 'vitest';
import {
  NICKNAME_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  buildShareUrl,
  clearCurrentSession,
  loadCurrentSession,
  loadSettings,
  normalizeRoomCode,
  roomCodeFromUrl,
  saveSession,
  saveSettings,
  validateNickname,
  validateRoomCode,
  validateRoomName,
} from './lobby.js';

class MemoryStorage implements Storage {
  readonly data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe('lobby validation and links', () => {
  it('validates field boundaries and normalizes room codes', () => {
    expect(validateNickname('  ')).toContain('1–24');
    expect(validateNickname('甲'.repeat(25))).toContain('1–24');
    expect(validateNickname(' 甲 ')).toBeNull();
    expect(validateRoomName('')).toContain('1–40');
    expect(validateRoomName('桌'.repeat(41))).toContain('1–40');
    expect(validateRoomCode(' abc123 ')).toBeNull();
    expect(validateRoomCode('abc!23')).toContain('6 位');
    expect(normalizeRoomCode(' ab12cd ')).toBe('AB12CD');
  });

  it('prefills only valid share codes and emits a secret-free link', () => {
    expect(roomCodeFromUrl(new URL('https://game.test/?room=abc123'))).toBe(
      'ABC123',
    );
    expect(roomCodeFromUrl(new URL('https://game.test/?room=bad'))).toBe('');
    const share = buildShareUrl(
      new URL('https://game.test/play?room=OLD&reconnectToken=secret#x'),
      'ABC123',
    );
    expect(share).toBe('https://game.test/play?room=ABC123');
    expect(share).not.toContain('secret');
  });
});

describe('local persistence', () => {
  it('saves and restores settings and falls back from corrupt values', () => {
    const storage = new MemoryStorage();
    const settings = {
      soundEffects: false,
      soundVolume: 0.3,
      backgroundMusic: true,
      reducedMotion: true,
    };
    saveSettings(storage, settings);
    expect(loadSettings(storage)).toEqual(settings);
    storage.setItem(SETTINGS_STORAGE_KEY, '{bad');
    expect(loadSettings(storage)).toEqual({
      soundEffects: true,
      soundVolume: 0.45,
      backgroundMusic: false,
      reducedMotion: false,
    });
  });

  it('isolates credentials by room and player without touching nickname storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(NICKNAME_STORAGE_KEY, '甲');
    saveSession(storage, {
      roomId: 'room-1' as never,
      playerId: 'p1' as never,
      reconnectToken: 'a'.repeat(32),
    });
    saveSession(storage, {
      roomId: 'room-2' as never,
      playerId: 'p2' as never,
      reconnectToken: 'b'.repeat(32),
      view: { forbidden: true },
      socket: { forbidden: true },
    } as never);
    expect(storage.length).toBe(4);
    expect(storage.getItem(NICKNAME_STORAGE_KEY)).toBe('甲');
    expect(
      [...storage.data.keys()].filter((key) =>
        /^8cards:session:room-/.test(key),
      ),
    ).toHaveLength(2);
    expect(loadCurrentSession(storage)).toMatchObject({
      roomId: 'room-2',
      playerId: 'p2',
      reconnectToken: 'b'.repeat(32),
    });
    expect(JSON.stringify([...storage.data.values()])).not.toContain(
      'forbidden',
    );
    clearCurrentSession(storage);
    expect(loadCurrentSession(storage)).toBeNull();
    expect(storage.getItem(NICKNAME_STORAGE_KEY)).toBe('甲');
  });
});
