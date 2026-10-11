-- Postgres schema (see docs/ARCHITECTURE.md §8). The API currently runs on an
-- in-memory store; a Postgres-backed Store implements the same interface.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  locale text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('m3u_url','m3u_file','xtream','xmltv','tuner')),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config_encrypted bytea,
  ownership_attested_at timestamptz NOT NULL,
  last_sync_at timestamptz
);

CREATE TABLE user_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE user_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid REFERENCES user_sources(id) ON DELETE SET NULL,
  name text NOT NULL,
  logo_url text,
  group_name text,
  stream_url text NOT NULL,
  epg_channel_id text,
  sort_order int NOT NULL DEFAULT 0,
  hidden boolean NOT NULL DEFAULT false
);

CREATE TABLE programmes (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  epg_channel_id text NOT NULL,
  start_utc timestamptz NOT NULL,
  end_utc timestamptz NOT NULL,
  title text NOT NULL,
  description text,
  category text,
  lang text
);
CREATE INDEX programmes_lookup ON programmes (epg_channel_id, start_utc);

-- Row-level security: every user_* table is scoped to the current user.
ALTER TABLE user_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_groups   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON user_sources  USING (user_id = current_setting('app.user_id')::uuid);
CREATE POLICY own_rows ON user_groups   USING (user_id = current_setting('app.user_id')::uuid);
CREATE POLICY own_rows ON user_channels USING (user_id = current_setting('app.user_id')::uuid);
