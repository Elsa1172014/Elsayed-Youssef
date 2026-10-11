-- Metadata-only directory of channels with no free public stream (subscription/encrypted/regional).
-- Deliberately has NO stream/url columns: playback is only ever via the user's own subscription.
CREATE TABLE premium_channels (
  id text PRIMARY KEY,
  name text NOT NULL,
  country text,
  languages jsonb NOT NULL DEFAULT '[]',
  categories jsonb NOT NULL DEFAULT '[]',
  logo_url text,
  website text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','closed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX premium_channels_country ON premium_channels (country) WHERE status = 'active';
CREATE INDEX premium_channels_name ON premium_channels (lower(name));

-- A user's own channel linked to a directory entry (grouped in the Premium view).
ALTER TABLE user_channels ADD COLUMN premium_id text REFERENCES premium_channels(id) ON DELETE SET NULL;
