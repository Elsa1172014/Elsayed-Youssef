# AI Repair & Play

The ✦ button next to every channel runs a real diagnose → repair → find-source → play pipeline.
Success means **media is actually playing** (a hidden muted player must receive data and advance its clock); HTTP 200 alone never counts.

## Flow

| Step | Where | What it really does |
|---|---|---|
| Device | browser (`engine.ts`) | hls.js/native HLS/dash.js support, codec support via `MediaSource.isTypeSupported`, key systems via `requestMediaKeySystemAccess` |
| Inspect | API `POST /v1/me/channels/:id/diagnose` | SSRF-guarded fetch: HTTP status, type (HLS/DASH/MP4/TS/WebM), playlist validity, variant → first segment, magic-byte check that the segment is media, declared codecs, DRM/AES detection |
| Protection | `packages/core/src/playback.ts` | Widevine / PlayReady / FairPlay / ClearKey from `EXT-X-KEY` and DASH `ContentProtection`; license URLs only if the provider's own manifest publishes them |
| Play | browser | engines `hlsjs → native` (HLS) or `dashjs`, modes `direct → relay` (relay only through the signed `/v1/proxy`), bounded retry with capped exponential backoff for transient causes only |
| Repair | API `POST …/find-source` | (1) fresh link from the user's **own** source (their M3U URL or Xtream account), (2) the same channel in the user's other registered sources, (3) other listed streams of the same free-catalog channel. Each candidate is probed server-side; only passing, DRM-free ones are returned and then **verified again in the real player** |
| Remember | browser `localStorage` | the working source/engine/mode per channel; the Player tries it first next time (relayed alternates expire with their 6 h signed link) |

## Strict channel identity

An alternate is accepted only if the official id (tvg-id / iptv-org id) matches, or the cleaned name is **identical**
(quality tags like HD/1080p/[Not 24/7] are ignored; digits and words are not) and country/language do not contradict.
"beIN SPORTS 1" never matches "beIN SPORTS 2" or "beIN SPORTS News".

## Hard legal boundary

Nothing in this feature bypasses CORS policy (the signed relay is the platform's existing, SSRF-guarded path, not a way around a provider's access rules),
geo-blocks, logins, entitlements, or DRM. Outcomes that need the user are reported, not worked around:

- 401 / rejected Xtream login / lapsed subscription → "sign in again" (Manage → your source).
- DRM → needs the provider's subscription/licence. Playback is attempted only when the provider's own manifest advertises a license server **and** the device supports that key system.
  Otherwise the panel explains why (subscription needed, or device lacks the key system).
- 403 / 451 / 404 → reported with the real cause; only the channel's own authorized alternates are tried.

## Not yet covered

- Provider-specific licence/entitlement APIs (token exchange, device registration). These need the provider's documented integration and credentials from the user's own account.
- FairPlay needs the provider's certificate and licence endpoint; it is detected and reported, not played.
- The remembered source lives in the browser (per device), not the account.
