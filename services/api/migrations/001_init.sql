-- Schema for the Smart Receiver API (see docs/ARCHITECTURE.md §8).
-- user_id is text until the auth provider is chosen (auth is deferred); it will become a FK then.

CREATE TABLE user_sources (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('m3u_url','m3u_file','xtream','xmltv','tuner')),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  url text,
  secret_enc text,                       -- AES-256-GCM envelope, never returned by the API
  ownership_attested_at timestamptz NOT NULL,
  last_sync_at timestamptz
);
CREATE INDEX user_sources_user ON user_sources (user_id);

CREATE TABLE user_channels (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  source_id text REFERENCES user_sources(id) ON DELETE CASCADE,
  name text NOT NULL,
  logo_url text,
  group_name text,
  stream_url text NOT NULL,
  epg_channel_id text,
  sort_order int NOT NULL DEFAULT 0,
  hidden boolean NOT NULL DEFAULT false
);
CREATE INDEX user_channels_user ON user_channels (user_id, sort_order);

CREATE TABLE guide_channels (
  user_id text NOT NULL,
  source_key text NOT NULL,
  epg_channel_id text NOT NULL,
  display_names jsonb NOT NULL DEFAULT '[]',
  icon text,
  PRIMARY KEY (user_id, source_key, epg_channel_id)
);

CREATE TABLE programmes (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  source_key text NOT NULL,
  priority int NOT NULL DEFAULT 0,
  epg_channel_id text NOT NULL,
  start_utc timestamptz NOT NULL,
  end_utc timestamptz NOT NULL,
  title text NOT NULL,
  description text,
  category text,
  lang text
);
CREATE INDEX programmes_lookup ON programmes (user_id, epg_channel_id, start_utc);

CREATE TABLE watch_events (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  channel_id text NOT NULL,
  seconds int NOT NULL CHECK (seconds > 0),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watch_events_user ON watch_events (user_id);

-- Shared, read-only-to-users catalog of legal sources (official / FAST / directory / FTA).
CREATE TABLE catalog_channels (
  id text PRIMARY KEY,
  name text NOT NULL,
  country text,
  languages jsonb NOT NULL DEFAULT '[]',
  categories jsonb NOT NULL DEFAULT '[]',
  logo_url text,
  website text,
  provenance text NOT NULL CHECK (provenance IN ('official','fast','directory','fta')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','closed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_streams (
  id bigserial PRIMARY KEY,
  channel_id text NOT NULL REFERENCES catalog_channels(id) ON DELETE CASCADE,
  url text NOT NULL,
  quality text,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','ok','dead')),
  latency_ms int,
  last_checked_at timestamptz,
  UNIQUE (channel_id, url)
);
