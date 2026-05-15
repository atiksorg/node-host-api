-- api/db/schema.sql
-- DDL для SQLite базы данных платформы

CREATE TABLE IF NOT EXISTS apps (
  id            TEXT PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'stopped',
  port          INTEGER,
  dir           TEXT,
  source_type   TEXT,
  source_url    TEXT,
  start_script  TEXT DEFAULT 'index.js',
  env_json      TEXT DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);
CREATE INDEX IF NOT EXISTS idx_apps_name ON apps(name);
