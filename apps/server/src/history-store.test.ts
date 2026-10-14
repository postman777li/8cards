import { describe, expect, it } from 'vitest';
import type { GameRecord, VisitorId } from '@8cards/shared';
import { SqliteHistoryStore } from './history-store.js';

describe('SQLite history store', () => {
  it('survives a database reopen and limits recent games to the newest 20', () => {
    const directory = mkdtempSync(join(tmpdir(), '8cards-history-'));
    const filename = join(directory, 'history.sqlite');
    const visitorId = 'persistent-visitor' as VisitorId;
    try {
      const first = new SqliteHistoryStore(filename);
      for (let index = 0; index < 21; index += 1) {
        const record: GameRecord = {
          gameId: `persistent-game-${index}`,
          roomName: `重开验证 ${index}`,
          playerCount: 2,
          startedAt: `2026-10-14T00:${String(index).padStart(2, '0')}:00.000Z`,
          endedAt: `2026-10-14T00:${String(index).padStart(2, '0')}:30.000Z`,
          reason: 'emptied-hand',
          participants: [
            {
              playerId: 'persistent-player' as never,
              nickname: '持久访客',
              seat: 0,
              team: 'solo',
              outcome: 'win',
            },
            {
              playerId: 'opponent' as never,
              nickname: '对手',
              seat: 1,
              team: 'solo',
              outcome: 'loss',
            },
          ],
        };
        first.saveGame({
          record,
          visitorByPlayer: { 'persistent-player': visitorId },
        });
      }
      first.close();

      const reopened = new SqliteHistoryStore(filename);
      const history = reopened.getVisitorHistory(visitorId);
      expect(history.stats).toEqual({
        games: 21,
        wins: 21,
        losses: 0,
        unresolved: 0,
      });
      expect(history.recent).toHaveLength(20);
      expect(history.recent[0]?.gameId).toBe('persistent-game-20');
      expect(history.recent.at(-1)?.gameId).toBe('persistent-game-1');
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
