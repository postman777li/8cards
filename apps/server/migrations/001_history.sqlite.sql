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
