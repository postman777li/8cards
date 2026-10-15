CREATE TABLE IF NOT EXISTS room_series (
  series_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  ended_at TEXT NOT NULL
);
