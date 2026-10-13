import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { GameRecord, VisitorId } from '@8cards/shared';

export interface PersistedGame {
  record: GameRecord;
  visitorByPlayer: Readonly<Record<string, VisitorId>>;
}

export interface VisitorHistory {
  stats: { games: number; wins: number; losses: number; unresolved: number };
  recent: GameRecord[];
}

export interface HistoryStore {
  saveGame(game: PersistedGame): 'inserted' | 'existing';
  getVisitorHistory(visitorId: VisitorId, limit?: number): VisitorHistory;
  close?(): void;
}

export class SqliteHistoryStore implements HistoryStore {
  readonly #db: DatabaseSync;

  constructor(
    filename = process.env.EIGHTCARDS_DB ??
      (process.env.NODE_ENV === 'test' ? ':memory:' : 'data/8cards.sqlite'),
  ) {
    if (filename !== ':memory:')
      mkdirSync(dirname(filename), { recursive: true });
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        ended_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_visitors (
        game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
        visitor_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('win','loss','unresolved')),
        PRIMARY KEY (game_id, visitor_id)
      );
      CREATE INDEX IF NOT EXISTS game_visitors_lookup
        ON game_visitors(visitor_id, game_id);
    `);
  }

  saveGame(game: PersistedGame): 'inserted' | 'existing' {
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

  getVisitorHistory(visitorId: VisitorId, limit = 20): VisitorHistory {
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
    const stats = { games: 0, wins: 0, losses: 0, unresolved: 0 };
    for (const row of all) {
      stats.games += Number(row.count);
      if (row.outcome === 'win') stats.wins += Number(row.count);
      else if (row.outcome === 'loss') stats.losses += Number(row.count);
      else stats.unresolved += Number(row.count);
    }
    return {
      stats,
      recent: rows.map((row) => JSON.parse(row.record_json) as GameRecord),
    };
  }

  close() {
    this.#db.close();
  }
}
