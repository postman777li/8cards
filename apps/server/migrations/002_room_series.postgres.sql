CREATE TABLE IF NOT EXISTS room_series (
  series_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  summary_json JSONB NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL
);
