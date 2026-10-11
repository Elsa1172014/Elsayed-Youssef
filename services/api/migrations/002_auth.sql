-- Username/password accounts and revocable opaque session tokens (only SHA-256 hashes are stored).
CREATE TABLE users (
  id text PRIMARY KEY,
  username text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Tie all user-owned data to the account so deleting the account deletes the data.
ALTER TABLE user_sources   ADD CONSTRAINT user_sources_user_fk   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_channels  ADD CONSTRAINT user_channels_user_fk  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE guide_channels ADD CONSTRAINT guide_channels_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE programmes     ADD CONSTRAINT programmes_user_fk     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE watch_events   ADD CONSTRAINT watch_events_user_fk   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
