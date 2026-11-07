-- Global IPTV MCP: per-user access tokens (SHA-256 hashes only), server-side favourites and stream-check history.
-- Same security model as the rest of schema "hub": RLS on, no anon/authenticated access, server role hub_app only.

create table if not exists hub.mcp_tokens (
  id           bigserial primary key,
  user_id      text not null,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label        text not null default 'MCP',
  auto_sync    boolean not null default true,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists mcp_tokens_user_idx on hub.mcp_tokens (user_id);

create table if not exists hub.mcp_favourites (
  user_id    text not null,
  channel_id text not null,
  name       text not null,
  note       text,
  added_at   timestamptz not null default now(),
  primary key (user_id, channel_id)
);

create table if not exists hub.stream_checks (
  id          bigserial primary key,
  user_id     text not null,
  channel_id  text not null,
  ok          boolean not null,
  cause       text,
  kind        text,
  http_status integer,
  latency_ms  integer,
  trigger     text not null default 'tool' check (trigger in ('tool', 'cron')),
  checked_at  timestamptz not null default now()
);
create index if not exists stream_checks_user_channel_idx on hub.stream_checks (user_id, channel_id, checked_at desc);

alter table hub.mcp_tokens     enable row level security;
alter table hub.mcp_favourites enable row level security;
alter table hub.stream_checks  enable row level security;
revoke all on hub.mcp_tokens, hub.mcp_favourites, hub.stream_checks from anon, authenticated;
revoke all on sequence hub.mcp_tokens_id_seq, hub.stream_checks_id_seq from anon, authenticated;

-- Retention for the check history (called from the hub cron through hub.prune_logs()).
create or replace function hub.prune_logs() returns void language sql security invoker set search_path = '' as $$
  delete from hub.error_log where at < now() - interval '30 days';
  delete from hub.job_runs where started_at < now() - interval '60 days';
  delete from hub.stream_checks where checked_at < now() - interval '30 days';
$$;
revoke all on function hub.prune_logs() from public, anon, authenticated;
