# Roadmap — Global Smart Receiver AI Platform

Status: living document. Update it in the same PR that changes scope. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design behind each item.

**Standing constraint on every phase:** legal sources only (official free channels, FAST, open directories like iptv-org, free-to-air satellite, and user-supplied sources the user owns). No decryption, card-sharing or DRM bypass. Users keep full editing control over their own channels and sources.

Work ships as small reviewed pull requests with tests.

---

## Phase 0 — Foundations (≈ 2–3 weeks)

**Goals:** repo, standards and a walking skeleton.

**Deliverables**
- Monorepo scaffolding (`apps/`, `services/`, `packages/`, `infra/`), CI (lint, typecheck, test), PR template including the legal-sources checklist.
- OpenAPI spec skeleton and generated TypeScript client.
- ADRs for the open decisions in ARCHITECTURE §11.
- Dev environment: Docker Compose (Postgres, Redis), seed data.
- `packages/core`: tolerant M3U/M3U8 parser with a fixture corpus and unit tests.

**Exit criteria:** CI green on an empty-but-wired stack; parser passes the fixture suite.

---

> **Progress (live)**
> - **Distribution decision (owner):** one web app/PWA for every device. App-store and TV-store publishing is **cancelled** (no Apple/Google/Samsung/LG accounts needed).
> - **Done, tested:** username/password auth (scrypt, revocable sessions, rate limits, account deletion); Postgres store with migrations; M3U/XMLTV/Xtream sources with encrypted credentials and additive re-sync; SSRF-safe fetching; **full iptv-org catalog sync verified on the real dataset (9,537 channels, 14.8k streams, 178 countries; blocklist honored, adult/closed/header-dependent entries excluded, upstream removals retired)**; filters by country/category/language and one-click bulk import; stream health probing; multi-source EPG; hybrid search; recommendations; EPG auto-map suggestions.
> - **Done, verified in a real browser under the production CSP:** web app (live, guide, free channels, manage; AR/EN RTL; PWA manifest).
> - **One-command deployment:** `./scripts/setup.sh` (Docker Compose: Postgres + API + background worker + Caddy with automatic HTTPS). CI runs the whole stack end to end.
> - **Optional, not on the release path:** Android and iOS source skeletons.
> - **Blocked on the owner:** actually running it somewhere (see [DEPLOYMENT.md](./DEPLOYMENT.md)); a verified official/FAST channel list (`catalog/official.json` is empty by design).
> - **Not started:** real-model embeddings (interface ready), pgvector at catalog scale, FTA tuner integration, cross-device sync, parental controls, opt-in stream relay for CORS/mixed-content cases, password recovery.

---

## Phase 1 — MVP: Legal Live TV + Own Playlists (≈ 6–8 weeks)

**Goals:** a user can sign in, watch legal live channels on web, and manage their own channels and playlists.

**Deliverables**
- **Backend:** auth (email + device-code pairing), profiles, channel catalog, source registry with provenance flags, user sources (M3U URL/file) with ownership attestation, encrypted credential storage, change-log sync.
- **Ingestion:** iptv-org sync (channels, streams, logos), curated official-channel list (e.g. Al Jazeera, Sky News Arabia), basic stream health checker.
- **Channel management (editing):** add/remove/rename/regroup/reorder/hide channels, edit logo and stream URL on user-owned entries, import/export M3U, enable/disable/delete sources.
- **EPG v1:** XMLTV ingestion, channel mapping via `tvg-id`, now/next, simple grid; per-channel manual EPG override.
- **Web PWA:** live TV list, player (hls.js/Shaka), EPG grid, channel manager, Arabic + English with RTL.
- **Quality:** API contract tests, ingestion fixtures, player smoke E2E, basic observability.

**Exit criteria:** end-to-end demo: import an owned M3U, edit channels, watch with guide, state persists across sessions and devices.

---

## Phase 2 — Smart TV & Mobile Apps (≈ 8–10 weeks)

**Goals:** first-class 10-foot and mobile experiences.

**Deliverables**
- **Android / Android TV** (Kotlin, Compose, Media3) with TV Input/Channels integration.
- **iOS / tvOS** (SwiftUI, AVPlayer) with PiP.
- ~~Samsung Tizen / LG webOS / store packages~~ — cancelled (web-only distribution); TV-browser remote-key and focus handling stays in scope.
- Xtream Codes support for user-owned accounts (live categories first).
- Favourites, recent channels, parental controls, multi-profile.
- Failover between candidate streams; client QoE telemetry.
- FTA tuner integration via HDHomeRun/TVHeadend/SAT>IP on LAN and Android TV tuner (no CA/decryption).

**Exit criteria:** the web app works on current Chrome, Safari, Firefox and at least two smart-TV browsers; cold start to first frame within budget.

---

## Phase 3 — AI Search & Recommendations (≈ 6–8 weeks)

**Goals:** make discovery effortless, in Arabic and English.

**Deliverables**
- Hybrid search (lexical + embeddings) with Arabic normalization and transliteration matching.
- Natural-language query parsing ("football tonight", "Arabic news live now") grounded strictly in legal catalog + the user's own sources.
- Voice search on supported platforms.
- Recommendations v1: continue watching, on-now-for-you, similar channels; content-based first, then implicit-feedback collaborative filtering; per-profile opt-out.
- AI helpers: EPG auto-mapping suggestions, playlist cleanup (duplicates, dead links) — always user-approved.
- Evaluation harness with Arabic/English query sets; latency and cost budgets.

**Exit criteria:** measurable lift in search success and channel-start rate vs. Phase 2 baseline; opt-out and data-deletion verified.

---

## Phase 4 — Unified EPG at Scale & Catalog Growth (≈ 6 weeks)

**Goals:** a trustworthy guide and a bigger legal catalog.

**Deliverables**
- Multi-source EPG merge with priority rules, conflict resolution, CDN-served snapshots, freshness SLO (< 6 h).
- Programme metadata enrichment (artwork, synopsis, translations Arabic ↔ English).
- Additional FAST providers where their terms permit (otherwise deep-link to the official app).
- Reminders and recording hooks for user-owned tuners only (local PVR via TVHeadend/HDHomeRun).
- Admin/moderation console: takedown flags, source review queue, abuse handling.

---

## AI Repair & Play (shipped)

Per-channel ✦ button: real stream inspection, bounded automatic repair, strict same-channel alternate search, verified playback. See [AI_REPAIR.md](AI_REPAIR.md).

## Phase 5 — Scale, Polish & Ecosystem (ongoing)

**Goals:** reliability, growth and extensibility.

**Deliverables**
- Service split where load requires (EPG, search); autoscaling, multi-region read replicas.
- Cross-device handoff (start on phone, continue on TV), casting (Chromecast/AirPlay).
- Accessibility audit, additional locales.
- Public, documented API for user-owned data export; optional self-hosted "home hub" for LAN tuners.
- Monetization options that respect the legal model (premium features such as cloud sync and advanced AI; never paid-channel redistribution).

---

## Cross-phase tracks

| Track | Ongoing work |
|---|---|
| Legal & compliance | Provenance flags, attestation audit log, takedown process, PR checklist, periodic source review |
| Quality | Fixture corpus growth, device lab, load tests, SLO dashboards |
| Security & privacy | Credential encryption, SSRF protection, data export/deletion, dependency scanning |
| Docs | ADRs, this roadmap, API reference — updated with each PR |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Directory/FAST streams change or die | Health checker, multi-candidate failover, quick catalog refresh |
| Many free streams fail in a browser (HTTP on HTTPS pages, missing CORS) | HTTPS-first stream selection, health checks, native HLS where available; optional opt-in relay later |
| Fragmented TV browsers | Reference-browser matrix; native HLS path; focus/remote-key handling |
| AI cost/latency | Caching, small models for parsing/embeddings, strict budgets |
| EPG mismatches | Fuzzy auto-map plus user override |
