-- Server role access to the MCP tables (run after supabase_hub_app_role.sql).
grant select, insert, update, delete on hub.mcp_tokens, hub.mcp_favourites, hub.stream_checks to hub_app;
grant usage, select on sequence hub.mcp_tokens_id_seq, hub.stream_checks_id_seq to hub_app;
grant execute on function hub.prune_logs() to hub_app;
create policy hub_app_all on hub.mcp_tokens     for all to hub_app using (true) with check (true);
create policy hub_app_all on hub.mcp_favourites for all to hub_app using (true) with check (true);
create policy hub_app_all on hub.stream_checks  for all to hub_app using (true) with check (true);
