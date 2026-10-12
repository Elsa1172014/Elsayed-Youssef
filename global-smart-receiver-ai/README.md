# GLOBAL SMART RECEIVER AI (Phase 1 shell)

Independent project; does not touch the Arabic-assessment app in the repo root.

## Implemented
- Responsive PWA shell (AR/RTL ⇄ EN/LTR), 14-item navigation, local favorites.
- **Short Dramas channel**: directory of official micro-drama platforms (opens each provider's own site) + vertical player for *licensed own episodes* from `data/short-dramas-own.json` (empty by default).

## Not implemented yet (honest status)
Live TV import engine, hls.js player, satellites, EPG, admin, AI features, receiver integration, accounts. Provider links are marked **unverified**: run `node scripts/check-links.mjs` on a normal network.

## Run / test
```
python3 -m http.server 8080   # or any static server; deploys to Vercel as a static site
node --test tests/*.test.mjs
```
Why a directory, not embedded video: ReelShort/DramaBox/etc. content is licensed and paid; embedding or re-streaming it is not permitted, and DRM/paywalls are never bypassed.
