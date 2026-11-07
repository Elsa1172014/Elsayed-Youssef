-- Entertainment Hub — Supabase schema "hub" (isolated from the host project's own "public" tables).
-- Access model: only the platform's server reaches these tables, through a direct Postgres connection
-- (SUPABASE_DB_URL, server-side env var). RLS is enabled on every table with NO policies for anon/authenticated,
-- and their privileges are revoked, so the public Data API (anon key / user JWTs) can neither read nor write.

create schema if not exists hub;
revoke all on schema hub from public;
revoke all on schema hub from anon, authenticated;

-- Movies and series: metadata from TMDB (cached ≤ 6 months per TMDB terms); "where to watch" = JustWatch via TMDB.
create table if not exists hub.titles (
  id               bigserial primary key,
  tmdb_id          integer not null,
  kind             text not null check (kind in ('movie', 'tv')),
  title            text not null,
  original_title   text,
  overview         text,
  poster_path      text,
  backdrop_path    text,
  release_date     date,
  vote_average     numeric(3, 1),
  genres           jsonb not null default '[]'::jsonb,
  original_language text,
  providers        jsonb not null default '{}'::jsonb,
  providers_region text,
  trending_rank    integer,
  featured         boolean not null default false,
  updated_at       timestamptz not null default now(),
  unique (kind, tmdb_id)
);
create index if not exists titles_trending_idx on hub.titles (trending_rank) where trending_rank is not null;
create index if not exists titles_updated_idx on hub.titles (updated_at);

-- Licensed playback sources the operator has the rights to show (own content, licensed FAST/AVOD feeds).
-- DRM: only an official license server of the rights holder; the browser's CDM does the decryption.
create table if not exists hub.licensed_sources (
  id            bigserial primary key,
  title_id      bigint not null references hub.titles (id) on delete cascade,
  label         text not null,
  url           text not null check (url ~ '^https://'),
  kind          text not null default 'hls' check (kind in ('hls', 'dash', 'mp4')),
  drm_system    text check (drm_system in ('widevine', 'playready', 'fairplay', 'clearkey')),
  license_url   text check (license_url is null or license_url ~ '^https://'),
  rights_holder text not null,
  license_ref   text not null,
  valid_until   date,
  enabled       boolean not null default true,
  created_by    text,
  created_at    timestamptz not null default now(),
  check ((drm_system is null) = (license_url is null))
);
create index if not exists licensed_sources_title_idx on hub.licensed_sources (title_id);

-- Matches: TheSportsDB leagues the operator follows, and their upcoming / recent events.
create table if not exists hub.sports_leagues (
  id_league text primary key,
  name      text not null,
  sport     text,
  enabled   boolean not null default true,
  added_at  timestamptz not null default now()
);

create table if not exists hub.sports_events (
  id_event    text primary key,
  id_league   text references hub.sports_leagues (id_league) on delete cascade,
  league      text,
  sport       text,
  season      text,
  home_team   text,
  away_team   text,
  home_badge  text,
  away_badge  text,
  event_time  timestamptz,
  venue       text,
  status      text,
  home_score  integer,
  away_score  integer,
  thumb       text,
  updated_at  timestamptz not null default now()
);
create index if not exists sports_events_time_idx on hub.sports_events (event_time);
create index if not exists sports_events_league_idx on hub.sports_events (id_league);

-- Scheduled jobs and their errors (admin panel).
create table if not exists hub.job_runs (
  id          bigserial primary key,
  job         text not null,
  trigger     text not null default 'cron' check (trigger in ('cron', 'manual')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  stats       jsonb not null default '{}'::jsonb,
  error       text
);
create index if not exists job_runs_started_idx on hub.job_runs (started_at desc);

create table if not exists hub.error_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  job      text,
  source   text not null,
  message  text not null,
  context  jsonb not null default '{}'::jsonb
);
create index if not exists error_log_at_idx on hub.error_log (at desc);

-- Row Level Security: enabled everywhere, no policies => deny-all for anon / authenticated.
alter table hub.titles           enable row level security;
alter table hub.licensed_sources enable row level security;
alter table hub.sports_leagues   enable row level security;
alter table hub.sports_events    enable row level security;
alter table hub.job_runs         enable row level security;
alter table hub.error_log        enable row level security;
revoke all on all tables in schema hub from anon, authenticated;
revoke all on all sequences in schema hub from anon, authenticated;
alter default privileges in schema hub revoke all on tables from anon, authenticated;
alter default privileges in schema hub revoke all on sequences from anon, authenticated;

-- Keep the error log bounded (called by the hub cron).
create or replace function hub.prune_logs() returns void language sql security invoker set search_path = '' as $$
  delete from hub.error_log where at < now() - interval '30 days';
  delete from hub.job_runs where started_at < now() - interval '60 days';
$$;
revoke all on function hub.prune_logs() from public, anon, authenticated;
