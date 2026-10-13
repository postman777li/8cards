import { describe, expect, it, vi } from 'vitest';
import {
  leaveSpectatorRoom,
  SPECTATOR_SESSION_STORAGE_KEY,
} from './spectator-session.js';

class MemoryStorage implements Storage {
  data = new Map<string, string>();
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

describe('spectator departure', () => {
  it('removes the credential only after the server confirms departure', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SPECTATOR_SESSION_STORAGE_KEY, 'credential');
    let confirm: () => void = () => undefined;
    const leave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
    );
    const operation = leaveSpectatorRoom({ leave }, storage);
    expect(storage.getItem(SPECTATOR_SESSION_STORAGE_KEY)).toBe('credential');
    confirm();
    await operation;
    expect(storage.getItem(SPECTATOR_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('retains the credential when departure is rejected or disconnected', async () => {
    for (const message of ['服务端拒绝', '连接已中断']) {
      const storage = new MemoryStorage();
      storage.setItem(SPECTATOR_SESSION_STORAGE_KEY, 'credential');
      await expect(
        leaveSpectatorRoom(
          { leave: vi.fn().mockRejectedValue(new Error(message)) },
          storage,
        ),
      ).rejects.toThrow(message);
      expect(storage.getItem(SPECTATOR_SESSION_STORAGE_KEY)).toBe('credential');
    }
  });
});
