# Deployment Readiness

Nothing is deployed or published yet. This page lists what is ready and what the project owner must supply. Store publishing and production hosting need accounts and credentials that only the owner holds, so they are intentionally not automated here.

## Ready now
- **CI** (`.github/workflows/ci.yml`): typecheck + tests for `packages/core` and `services/api`, and a production build of `apps/web`, on every PR.
- **API container**: `services/api/Dockerfile` (build from repo root). It deliberately fails to start with `NODE_ENV=production` until real authentication exists (see "Blockers").
- **DB schema**: `services/api/migrations/001_init.sql` (Postgres 16, row-level security per user).

## Blockers before a production API deploy
1. Replace `devAuthenticator` with OIDC/JWT verification (provider decision: ARCHITECTURE §11).
2. Implement the Postgres `Store` (the in-memory store loses data on restart).
3. Encrypt stored source credentials (KMS-managed key); credentials are not stored at all today.
4. Add DNS-resolution SSRF checks before any server-side fetch of user URLs (only the syntactic guard exists).

## What the owner needs to provide, by target
| Target | Needs |
|---|---|
| API hosting | Cloud account (Fly.io/Render/AWS), managed Postgres + Redis, domain + TLS, secrets store |
| Auth | OIDC provider tenant (Auth0/Clerk/Keycloak) and client IDs |
| Apple App Store / tvOS | Apple Developer Program membership, bundle IDs, signing certificates, App Store Connect API key |
| Google Play / Android TV | Play Console account, upload keystore, service-account JSON for fastlane/Gradle Play Publisher |
| Samsung Tizen TV | Samsung Seller Office account, Tizen author certificate |
| LG webOS TV | LG Seller Lounge account, webOS developer mode / signing |
| Web (`apps/web`, `npm run build` → `dist/`) | Static host (Vercel/Netlify/Cloudflare Pages) and domain |

Store submissions will also need a privacy policy, content-rating answers and the legal-sources statement from ARCHITECTURE §2.
