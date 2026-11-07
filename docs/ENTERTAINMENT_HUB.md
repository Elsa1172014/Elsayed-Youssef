# Entertainment Hub — وحدة الترفيه

Additive module: the rest of the platform behaves exactly as before when the Hub is not configured.

## Parts
| Part | Source | Notes |
|---|---|---|
| Movies & series | TMDB (metadata) + JustWatch via TMDB ("where to watch") | Cached ≤ 6 months (TMDB terms); TMDB + JustWatch credited in the UI |
| Licensed playback | `hub.licensed_sources` | https only; rights holder + licence reference + attestation required; DRM only via the rights holder's official license server (browser CDM decrypts) |
| Matches | TheSportsDB v1 | Followed leagues are managed in the admin panel |
| Receiver library | HDHomeRun `lineup.json`, Enigma2 OpenWebif `/api/getallservices`, or an authorised M3U export | Device-flagged protected channels are skipped; the server only reaches public https addresses |
| Open channels | iptv-org (existing catalog) | Blocklist and NSFW exclusions unchanged |
| Player | Shaka Player (HLS, DASH, Widevine/PlayReady/FairPlay/ClearKey with official licences) | |

## Data (Supabase, schema `hub`)
`services/api/hub/supabase_hub.sql` — applied to the Supabase project as migration `smart_receiver_entertainment_hub_schema`.
RLS is enabled on every table with no policies, and `anon`/`authenticated` have no privileges: the public Data API cannot read or write.
Only the platform server connects, with `SUPABASE_DB_URL`.

## Server env vars (Vercel → Settings → Environment Variables; never in the repo)
| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_DB_URL` | yes | Postgres connection string of the Supabase project (Transaction pooler, port 6543) |
| `TMDB_READ_TOKEN` | for movies/series | TMDB v4 read access token (or `TMDB_API_KEY`) |
| `THESPORTSDB_KEY` | no | Own key; defaults to the shared free key `123` |
| `HUB_ADMIN_USERS` | yes for admin | Comma-separated platform usernames allowed into the admin panel |
| `HUB_REGION` | no | "Where to watch" region, default `AE` |
| `CRON_SECRET` | already set | Protects `/api/cron` and `/api/hubCron` |

## Schedules
`/api/cron` 03:00 UTC (channel catalog, unchanged) · `/api/hubCron` 04:30 UTC (TMDB, TheSportsDB, log retention: errors 30 days, runs 60 days).
