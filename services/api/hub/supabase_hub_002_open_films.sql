-- Entertainment Hub 002: titles that do not come from TMDB (public-domain / open-licence films from the
-- Internet Archive, and the operator's own films), plus a small key/value table for job cursors.
alter table hub.titles alter column tmdb_id drop not null;
alter table hub.titles add column if not exists source text not null default 'tmdb';
alter table hub.titles add constraint titles_source_check check (source in ('tmdb', 'archive', 'own'));
alter table hub.titles add constraint titles_tmdb_id_check check (source <> 'tmdb' or tmdb_id is not null);
alter table hub.titles add column if not exists external_id text;
alter table hub.titles add column if not exists poster_url text check (poster_url is null or poster_url ~ '^https://');
alter table hub.titles add column if not exists release_year integer;
alter table hub.titles add column if not exists runtime_min integer;
alter table hub.titles add column if not exists license_url text;
alter table hub.titles add column if not exists source_page text;
create unique index if not exists titles_source_external_idx on hub.titles (source, external_id) where external_id is not null;
create index if not exists titles_source_idx on hub.titles (source);

create table if not exists hub.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table hub.settings enable row level security;
revoke all on hub.settings from anon, authenticated;
