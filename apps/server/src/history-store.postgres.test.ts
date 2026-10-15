import { randomUUID } from 'node:crypto';

import type { GameRecord, VisitorId } from '@8cards/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresHistoryStore } from './history-store.js';

const connectionString = process.env.POSTGRES_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres('PostgreSQL history store integration', () => {
  let store: PostgresHistoryStore;

  beforeAll(async () => {
    const database = new URL(connectionString!);
    if (!database.pathname.toLowerCase().includes('8cards_test'))
      throw new Error(
        'POSTGRES_TEST_DATABASE_URL must name an isolated 8cards_test database',
      );
    store = await PostgresHistoryStore.connect(connectionString!);
  });

  afterAll(async () => store.close());

  it('migrates, atomically deduplicates concurrent writes, and reads history', async () => {
    const suffix = randomUUID();
    const visitorId = `visitor-${suffix}` as VisitorId;
    const record: GameRecord = {
      gameId: `game-${suffix}`,
      roomName: 'PostgreSQL 集成测试',
      playerCount: 2,
      startedAt: '2026-10-14T00:00:00.000Z',
      endedAt: '2026-10-14T00:01:00.000Z',
      reason: 'emptied-hand',
      participants: [
        {
          playerId: 'postgres-player-1' as never,
          nickname: '甲',
          seat: 0,
          team: 'solo',
          outcome: 'win',
        },
        {
          playerId: 'postgres-player-2' as never,
          nickname: '乙',
          seat: 1,
          team: 'solo',
          outcome: 'loss',
        },
      ],
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.saveGame({
          record,
          visitorByPlayer: { 'postgres-player-1': visitorId },
        }),
      ),
    );
    expect(results.filter((result) => result === 'inserted')).toHaveLength(1);
    expect(results.filter((result) => result === 'existing')).toHaveLength(3);
    await expect(store.getVisitorHistory(visitorId)).resolves.toMatchObject({
      stats: { games: 1, wins: 1, losses: 0, unresolved: 0 },
      recent: [{ gameId: record.gameId }],
    });
  });

  it('persists a room-series summary with an idempotent key', async () => {
    const seriesId = `series-${randomUUID()}`;
    const value = {
      seriesId,
      roomId: `room-${randomUUID()}`,
      endedAt: '2026-10-15T00:00:00.000Z',
      summary: { scores: [2, -1, -1] },
    };
    await expect(store.saveSeries(value)).resolves.toBe('inserted');
    await expect(store.saveSeries(value)).resolves.toBe('existing');
  });
});
