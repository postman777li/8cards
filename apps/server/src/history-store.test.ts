import { describe, expect, it } from 'vitest';
import type { GameRecord, VisitorId } from '@8cards/shared';
import { SqliteHistoryStore } from './history-store.js';

describe('SQLite history store', () => {
  it('atomically deduplicates a game and derives visitor statistics', () => {
    const store = new SqliteHistoryStore(':memory:');
    const record: GameRecord = {
      gameId: 'game-1',
      roomName: '测试桌',
      playerCount: 3,
      startedAt: '2026-10-13T12:00:00.000Z',
      endedAt: '2026-10-13T12:10:00.000Z',
      reason: 'stuck-with-jokers',
      participants: [
        {
          playerId: 'p1' as never,
          nickname: '甲',
          seat: 0,
          team: 'solo',
          outcome: 'loss',
        },
        {
          playerId: 'p2' as never,
          nickname: '乙',
          seat: 1,
          team: 'solo',
          outcome: 'unresolved',
        },
        {
          playerId: 'p3' as never,
          nickname: '丙',
          seat: 2,
          team: 'solo',
          outcome: 'unresolved',
        },
      ],
    };
    const visitors = {
      p1: 'v1' as VisitorId,
      p2: 'v2' as VisitorId,
      p3: 'v3' as VisitorId,
    };
    expect(store.saveGame({ record, visitorByPlayer: visitors })).toBe(
      'inserted',
    );
    expect(store.saveGame({ record, visitorByPlayer: visitors })).toBe(
      'existing',
    );
    expect(store.getVisitorHistory('v1' as VisitorId)).toMatchObject({
      stats: { games: 1, wins: 0, losses: 1, unresolved: 0 },
    });
    expect(store.getVisitorHistory('v2' as VisitorId)).toMatchObject({
      stats: { games: 1, wins: 0, losses: 0, unresolved: 1 },
    });
    store.close();
  });

  it('stores an explicit two-player loss instead of an unresolved result', () => {
    const store = new SqliteHistoryStore(':memory:');
    const record: GameRecord = {
      gameId: 'game-2',
      roomName: '二人桌',
      playerCount: 2,
      startedAt: '2026-10-13T12:00:00.000Z',
      endedAt: '2026-10-13T12:05:00.000Z',
      reason: 'stuck-with-jokers',
      participants: [
        {
          playerId: 'p1' as never,
          nickname: '甲',
          seat: 0,
          team: 'solo',
          outcome: 'loss',
        },
        {
          playerId: 'p2' as never,
          nickname: '乙',
          seat: 1,
          team: 'solo',
          outcome: 'win',
        },
      ],
    };
    store.saveGame({
      record,
      visitorByPlayer: { p1: 'v1' as VisitorId, p2: 'v2' as VisitorId },
    });
    expect(store.getVisitorHistory('v1' as VisitorId).stats.losses).toBe(1);
    expect(store.getVisitorHistory('v1' as VisitorId).stats.unresolved).toBe(0);
    store.close();
  });
});
