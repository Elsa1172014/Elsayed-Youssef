-- Server role access to hub.settings (run after supabase_hub_app_role.sql). Skipped in environments without hub_app.
grant select, insert, update, delete on hub.settings to hub_app;
create policy hub_app_all on hub.settings for all to hub_app using (true) with check (true);
