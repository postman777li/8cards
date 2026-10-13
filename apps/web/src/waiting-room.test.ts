import { describe, expect, it, vi } from 'vitest';
import { loadCurrentSession, saveSession } from './lobby.js';
import { leaveWaitingRoom } from './waiting-room.js';

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

const stored = {
  roomId: 'room-1' as never,
  playerId: 'player-1' as never,
  reconnectToken: 'a'.repeat(32),
};

describe('waiting-room departure', () => {
  it('clears the current credential only after the server confirms departure', async () => {
    const storage = new MemoryStorage();
    saveSession(storage, stored);
    let confirm: () => void = () => undefined;
    const leave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
    );
    const operation = leaveWaitingRoom({ leave }, storage);
    expect(loadCurrentSession(storage)).toEqual(stored);
    confirm();
    await operation;
    expect(loadCurrentSession(storage)).toBeNull();
  });

  it('retains the credential when departure is rejected', async () => {
    const storage = new MemoryStorage();
    saveSession(storage, stored);
    await expect(
      leaveWaitingRoom(
        { leave: vi.fn().mockRejectedValue(new Error('房间状态已更新')) },
        storage,
      ),
    ).rejects.toThrow('房间状态已更新');
    expect(loadCurrentSession(storage)).toEqual(stored);
  });
});
