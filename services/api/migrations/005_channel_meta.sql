-- Catalog facts kept on the user's own channel so the Live tab can group them (Arabic, movies, news, sports...).
ALTER TABLE user_channels ADD COLUMN country text;
ALTER TABLE user_channels ADD COLUMN languages jsonb NOT NULL DEFAULT '[]';
ALTER TABLE user_channels ADD COLUMN categories jsonb NOT NULL DEFAULT '[]';

-- Backfill channels that were already added from the catalog (matched by stream URL).
UPDATE user_channels u SET country = m.country, languages = m.languages, categories = m.categories
  FROM (SELECT DISTINCT ON (s.url_hash) s.url_hash, c.country, c.languages, c.categories
          FROM catalog_streams s JOIN catalog_channels c ON c.id = s.channel_id ORDER BY s.url_hash, c.id) m
 WHERE md5(u.stream_url) = m.url_hash;
