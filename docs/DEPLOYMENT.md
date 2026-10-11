# Deployment Readiness

Nothing is deployed or published yet. This page lists what is ready and what the project owner must supply. Store publishing and production hosting need accounts and credentials that only the owner holds, so they are intentionally not automated here.

## Ready now
- **CI** (`.github/workflows/ci.yml`): typecheck + tests for `packages/core` and `services/api`, and a production build of `apps/web`, on every PR.
- **API container**: `services/api/Dockerfile` (build from repo root). It deliberately fails to start with `NODE_ENV=production` until real authentication exists (see "Blockers").
- **DB schema**: `services/api/migrations/001_init.sql` (Postgres 16, row-level security per user).

## Blockers before a production API deploy
1. **Authentication** — deferred by the owner. `devAuthenticator` (`Bearer dev:<user>`) refuses to run with `NODE_ENV=production`; replace it with OIDC/JWT verification (provider decision: ARCHITECTURE §11). Until then there is no safe production deploy.
2. **Postgres in production** — the store is tested against PGlite (a real Postgres engine in WASM). The `pg` driver path (`DATABASE_URL`) is implemented but has not been exercised against a managed Postgres; run the migrations on a staging database first.
3. **Secrets** — set `SECRET_KEY` (32 random bytes, base64) from a secret manager; plan key rotation (the sealed format is versioned `v1`).
4. **Egress hardening** — server-side fetches (source sync, catalog sync, health checks) validate every hop and resolved address, but DNS rebinding is a residual risk: run the API in a network that blocks private/metadata ranges.
5. **Scheduled jobs** — run `npm run sync-iptv-org` nightly and `npm run check-health` every ~15 minutes (cron / Kubernetes CronJob).
6. **Catalog content** — `catalog/official.json` is empty by design; add only channels you have verified are published by the channel itself or by a FAST provider whose terms allow it. Use `tsx src/jobs/cli.ts block <id>` for takedown requests.

## What the owner needs to provide, by target
| Target | Needs |
|---|---|
| API hosting | Cloud account (Fly.io/Render/AWS), managed Postgres + Redis, domain + TLS, secrets store |
| Auth | OIDC provider tenant (Auth0/Clerk/Keycloak) and client IDs |
| Apple App Store / tvOS | Apple Developer Program membership, bundle IDs, signing certificates, App Store Connect API key |
| Google Play / Android TV | Play Console account, upload keystore, service-account JSON for fastlane/Gradle Play Publisher |
| Samsung Tizen TV (`apps/package-tv.sh tizen <api>`) | Samsung Seller Office account, Tizen author certificate |
| LG webOS TV (`apps/package-tv.sh webos <api>`) | LG Seller Lounge account, webOS developer mode / signing |
| Web (`apps/web`, `npm run build` → `dist/`) | Static host (Vercel/Netlify/Cloudflare Pages) and domain |

Store submissions will also need a privacy policy, content-rating answers and the legal-sources statement from ARCHITECTURE §2.
