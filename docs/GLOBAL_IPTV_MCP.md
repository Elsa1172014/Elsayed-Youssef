# Global IPTV MCP

MCP server for Smart Receiver, built on the stable **@modelcontextprotocol/sdk 1.32.2** (Streamable HTTP, stateless, JSON responses).

- Endpoint: `https://<site>/mcp` (Vercel function `deploy/vercel/src/mcp.ts`)
- Auth: `Authorization: Bearer gim_…` — per-user tokens created in the app (الترفيه → 🔌 MCP). Only SHA-256 hashes are stored (`hub.mcp_tokens`); tokens can be revoked; max 5 per user.
- Every tool calls the platform's own API **in-process** as that user (a private, never-listening Fastify instance with an in-process identity), so it inherits the existing validation, SSRF guards, rate limits and ownership attestation. Existing endpoints are unchanged.

## Tools
| Tool | Uses | Notes |
|---|---|---|
| `search_channels` | `/v1/search`, `/v1/catalog` | user's channels + iptv-org directory; returns format + player + watch link |
| `discover_streams` | `/v1/catalog`, `/v1/me/channels/:id/stream` | authorised streams only; HLS → Shaka/hls.js, DASH → Shaka; DRM reported, never bypassed |
| `import_playlists` | `/v1/me/sources`, `/v1/me/playlists/import`, `/v1/catalog/import` | M3U needs `ownership_attested: true` |
| `sync_channels` | `/v1/me/sources/:id/sync`, `/v1/catalog/sync` | adds, never deletes |
| `validate_streams` | `/v1/me/channels/:id/diagnose` | ≤10 per call; results kept 30 days in `hub.stream_checks` |
| `get_epg` | `/v1/epg/now-next`, `/v1/epg/grid` | ≤48 h |
| `list_countries` | `/v1/catalog/facets`, `/v1/catalog/meta` | flags, counts, regions |
| `manage_favourites` | `hub.mcp_favourites` | list/add/remove with last check + watch link |

Watch links (`/?play=<channelId>`) open the channel in the web app's player (Shaka / hls.js / dash.js).

## Data (Supabase schema `hub`)
`supabase_hub_003_mcp.sql` + `supabase_hub_003_role.sql`: `mcp_tokens`, `mcp_favourites`, `stream_checks`. RLS on, no anon/authenticated access, server role `hub_app` only.

## Schedule
`/api/hubCron` (04:30 UTC) runs the Hub jobs, then `mcp-sync` with the remaining time budget: for each user with an auto-sync token, re-sync syncable sources and re-check up to 10 favourites. Logged in `hub.job_runs` / `hub.error_log`.

## Connect
- Claude Code: `claude mcp add --transport http global-iptv https://<site>/mcp --header "Authorization: Bearer gim_…"`
- Claude Desktop: `npx -y mcp-remote https://<site>/mcp --header "Authorization: Bearer gim_…"`
