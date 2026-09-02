-- Geolyssa D1 schema for local development.
--
-- Mirrors the CREATE TABLE + index that scripts/deploy.sh applies to the
-- production database (scripts/deploy.sh:87). Apply to the local simulated
-- D1 that `wrangler dev` uses:
--
--   wrangler d1 execute geolyssa --local --file=schema.sql
--
-- (Production schema changes still go through scripts/deploy.sh, which also
-- runs incremental ALTERs for pre-existing remote databases — out of scope
-- here, see issue #5.)

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  rock_json TEXT NOT NULL,
  rock_type TEXT NOT NULL,
  date TEXT,
  location TEXT,
  lat REAL,
  lng REAL,
  note TEXT,
  photo_key TEXT,
  created_at INTEGER NOT NULL,
  alternatives TEXT,
  macrostrat_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_created ON journal_entries(device_id, created_at DESC);
