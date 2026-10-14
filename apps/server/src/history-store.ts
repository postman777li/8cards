import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { GameRecord, VisitorId } from '@8cards/shared';
import { Pool, type PoolClient } from 'pg';

export interface PersistedGame {
  record: GameRecord;
  visitorByPlayer: Readonly<Record<string, VisitorId>>;
}

export interface VisitorHistory {
  stats: { games: number; wins: number; losses: number; unresolved: number };
  recent: GameRecord[];
}

export interface HistoryStore {
  saveGame(game: PersistedGame): Promise<'inserted' | 'existing'>;
  getVisitorHistory(
    visitorId: VisitorId,
    limit?: number,
  ): Promise<VisitorHistory>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const migrationPath = (dialect: 'sqlite' | 'postgres') =>
  process.env.EIGHTCARDS_MIGRATIONS_DIR
    ? resolve(
        process.env.EIGHTCARDS_MIGRATIONS_DIR,
        `001_history.${dialect}.sql`,
      )
    : fileURLToPath(
        new URL(`../migrations/001_history.${dialect}.sql`, import.meta.url),
      );

const readMigration = (dialect: 'sqlite' | 'postgres') =>
  readFileSync(migrationPath(dialect), 'utf8');

const emptyStats = () => ({ games: 0, wins: 0, losses: 0, unresolved: 0 });

const applyOutcome = (
  stats: ReturnType<typeof emptyStats>,
  outcome: 'win' | 'loss' | 'unresolved',
  count: number,
) => {
  stats.games += count;
  if (outcome === 'win') stats.wins += count;
  else if (outcome === 'loss') stats.losses += count;
  else stats.unresolved += count;
};

export class SqliteHistoryStore implements HistoryStore {
  readonly #db: DatabaseSync;

  constructor(
    filename = process.env.EIGHTCARDS_DB ??
      (process.env.NODE_ENV === 'test' ? ':memory:' : 'data/8cards.sqlite'),
  ) {
    if (filename !== ':memory:')
      mkdirSync(dirname(filename), { recursive: true });
    this.#db = new DatabaseSync(filename);
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#migrate();
  }

  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = this.#db
      .prepare('SELECT 1 FROM schema_migrations WHERE version = 1')
      .get();
    if (applied) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.exec(readMigration('sqlite'));
      this.#db
        .prepare(
          'INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)',
        )
        .run(new Date().toISOString());
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async saveGame(game: PersistedGame): Promise<'inserted' | 'existing'> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.#db
        .prepare(
          'INSERT OR IGNORE INTO games(game_id, record_json, ended_at) VALUES(?,?,?)',
        )
        .run(
          game.record.gameId,
          JSON.stringify(game.record),
          game.record.endedAt,
        );
      if (inserted.changes === 0) {
        this.#db.exec('COMMIT');
        return 'existing';
      }
      const statement = this.#db.prepare(
        'INSERT INTO game_visitors(game_id, visitor_id, player_id, outcome) VALUES(?,?,?,?)',
      );
      for (const participant of game.record.participants) {
        const visitorId = game.visitorByPlayer[participant.playerId];
        if (visitorId)
          statement.run(
            game.record.gameId,
            visitorId,
            participant.playerId,
            participant.outcome,
          );
      }
      this.#db.exec('COMMIT');
      return 'inserted';
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async getVisitorHistory(
    visitorId: VisitorId,
    limit = 20,
  ): Promise<VisitorHistory> {
    const rows = this.#db
      .prepare(
        `SELECT gv.outcome, g.record_json
         FROM game_visitors gv JOIN games g ON g.game_id = gv.game_id
         WHERE gv.visitor_id = ? ORDER BY g.ended_at DESC LIMIT ?`,
      )
      .all(visitorId, limit) as Array<{
      outcome: 'win' | 'loss' | 'unresolved';
      record_json: string;
    }>;
    const all = this.#db
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM game_visitors
         WHERE visitor_id = ? GROUP BY outcome`,
      )
      .all(visitorId) as Array<{
      outcome: 'win' | 'loss' | 'unresolved';
      count: number;
    }>;
    const stats = emptyStats();
    for (const row of all) applyOutcome(stats, row.outcome, Number(row.count));
    return {
      stats,
      recent: rows.map((row) => JSON.parse(row.record_json) as GameRecord),
    };
  }

  async ping() {
    this.#db.prepare('SELECT 1').get();
  }

  async close() {
    this.#db.close();
  }
}

export class PostgresHistoryStore implements HistoryStore {
  private constructor(readonly pool: Pool) {}

  static async connect(connectionString: string) {
    const pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: '8cards-server',
    });
    const store = new PostgresHistoryStore(pool);
    try {
      await store.#migrate();
      return store;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async #migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [803_2026]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const applied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [1],
      );
      if (applied.rowCount === 0) {
        await client.query(readMigration('postgres'));
        await client.query(
          'INSERT INTO schema_migrations(version) VALUES($1)',
          [1],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveGame(game: PersistedGame): Promise<'inserted' | 'existing'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO games(game_id, record_json, ended_at)
         VALUES($1, $2::jsonb, $3::timestamptz)
         ON CONFLICT (game_id) DO NOTHING
         RETURNING game_id`,
        [game.record.gameId, JSON.stringify(game.record), game.record.endedAt],
      );
      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        return 'existing';
      }
      await this.#insertVisitors(client, game);
      await client.query('COMMIT');
      return 'inserted';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async #insertVisitors(client: PoolClient, game: PersistedGame) {
    for (const participant of game.record.participants) {
      const visitorId = game.visitorByPlayer[participant.playerId];
      if (!visitorId) continue;
      await client.query(
        `INSERT INTO game_visitors(game_id, visitor_id, player_id, outcome)
         VALUES($1, $2, $3, $4)`,
        [
          game.record.gameId,
          visitorId,
          participant.playerId,
          participant.outcome,
        ],
      );
    }
  }

  async getVisitorHistory(
    visitorId: VisitorId,
    limit = 20,
  ): Promise<VisitorHistory> {
    const [recentResult, statsResult] = await Promise.all([
      this.pool.query<{
        outcome: 'win' | 'loss' | 'unresolved';
        record_json: GameRecord;
      }>(
        `SELECT gv.outcome, g.record_json
         FROM game_visitors gv JOIN games g ON g.game_id = gv.game_id
         WHERE gv.visitor_id = $1 ORDER BY g.ended_at DESC LIMIT $2`,
        [visitorId, limit],
      ),
      this.pool.query<{
        outcome: 'win' | 'loss' | 'unresolved';
        count: string;
      }>(
        `SELECT outcome, COUNT(*) AS count FROM game_visitors
         WHERE visitor_id = $1 GROUP BY outcome`,
        [visitorId],
      ),
    ]);
    const stats = emptyStats();
    for (const row of statsResult.rows)
      applyOutcome(stats, row.outcome, Number(row.count));
    return { stats, recent: recentResult.rows.map((row) => row.record_json) };
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  async close() {
    await this.pool.end();
  }
}

export async function createHistoryStore(): Promise<HistoryStore> {
  const databaseUrl = process.env.DATABASE_URL;
  return databaseUrl
    ? PostgresHistoryStore.connect(databaseUrl)
    : new SqliteHistoryStore();
}
