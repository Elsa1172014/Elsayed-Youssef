-- Full-catalog sync support: stamp rows seen by each sync so removed entries can be retired.
ALTER TABLE catalog_streams ADD COLUMN seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX catalog_channels_country ON catalog_channels (country) WHERE status = 'active';
CREATE INDEX catalog_channels_name ON catalog_channels (lower(name));
CREATE INDEX catalog_streams_check ON catalog_streams (last_checked_at NULLS FIRST);
CREATE TABLE sync_state (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
