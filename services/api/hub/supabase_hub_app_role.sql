-- Least-privilege login role used by the platform server (SUPABASE_DB_URL). Applied as migration
-- "smart_receiver_hub_app_role". The password is generated at setup time and stored only in Vercel (sensitive env var).
-- create role hub_app login noinherit nocreatedb nocreaterole password '<generated>';
alter role hub_app set search_path = hub, pg_catalog;
alter role hub_app set statement_timeout = '30s';
grant usage on schema hub to hub_app;
grant select, insert, update, delete on all tables in schema hub to hub_app;
grant usage, select on all sequences in schema hub to hub_app;
grant execute on function hub.prune_logs() to hub_app;
alter default privileges in schema hub grant select, insert, update, delete on tables to hub_app;
alter default privileges in schema hub grant usage, select on sequences to hub_app;
-- RLS stays deny-all for anon/authenticated; only hub_app gets an explicit policy.
create policy hub_app_all on hub.titles           for all to hub_app using (true) with check (true);
create policy hub_app_all on hub.licensed_sources for all to hub_app using (true) with check (true);
create policy hub_app_all on hub.sports_leagues   for all to hub_app using (true) with check (true);
create policy hub_app_all on hub.sports_events    for all to hub_app using (true) with check (true);
create policy hub_app_all on hub.job_runs         for all to hub_app using (true) with check (true);
create policy hub_app_all on hub.error_log        for all to hub_app using (true) with check (true);
