# Implementation plan

Working style: small verified milestones. After each: changed files, tests run, deployment state, blockers, next action (recorded in the table below and in the commit message).

## Smallest deployable vertical slice (first delivery)

One licensed textbook → ingested → one lesson → camera page recognition → grounded explanation → real voice Q&A → session persisted. Everything else (more books, analytics depth) comes after.

## Milestones

| # | Milestone | Scope | Status |
|---|---|---|---|
| M0 | Foundation | Inspect repo; Next.js/TS/Tailwind RTL scaffold; architecture, plan, acceptance docs, env example; PostgreSQL schema, functions, RLS, storage; DB tests on real Postgres+pgvector | ✅ schema/RLS/queue/search verified by 31 DB tests; `next build` ✅ |
| M1 | Ingestion | Arabic normalisation; PDF extract → pages; lesson boundaries; chunking; embeddings adapter; worker with leases/retries/idempotency; admin upload + status UI & API | ✅ pipeline verified end-to-end on real Postgres with a real (Chromium-generated) Arabic PDF; 🟡 worker process, Supabase Storage, OpenAI embeddings, signed upload NOT run against live services |
| M2 | Retrieval + tutor | Hybrid retrieval client; grounding gate; citation verifier; AI SDK tutor with tools; 5 modes; text chat UI | ✅ logic, guards, routes and UI behaviour verified with a scripted model (`ai/test`) and jsdom; 🟡 real LLM answers/tool use and grounding thresholds NOT verified (no OpenAI key) |
| M3 | Camera + page matching | getUserMedia FSM; stability detector; `/api/vision/recognize`; `decideMatch`; confirm flow; lesson card | ✅ logic/routes/UI states verified (mock vision model; real SQL `match_pages` on the real PDF); 🟡 live camera on a device, real OCR quality and match thresholds NOT verified |
| M4 | Realtime voice | Token endpoint; `RealtimeVoiceClient` FSM + WebRTC transport; transcripts; reconnect; vision→voice context push; tool endpoint | ✅ state machine (38 tests), WebRTC transport (fakes), token/tool/events routes, orb UI, vision→voice context push verified; 🟡 **no real voice session has been run** — OpenAI client-secret + WebRTC SDP endpoint, Arabic speech quality, barge-in on real audio, iOS/Android behaviour all UNVERIFIED (no key/device) |
| M5 | Persistence + teacher dashboard | Sessions/events/responses/mastery writes; AI-vs-teacher labelling; dashboard (progress, strengths, gaps, interventions) | ⬜ |
| M6 | Privacy + limits | Rate limits, budgets, export/delete, audit, minors policy hooks | ⬜ |
| M7 | Polish + deploy | Accessibility pass, mobile pass, Vercel config, worker image, runbook | ⬜ |

## Definition of done per milestone
`npm run typecheck` · `npm test` · `npm run test:db` · `npm run build` all green, and every feature marked ✅ has a test or a recorded command output proving it. Anything needing a live key is marked 🟡 with the exact manual verification steps in `acceptance-tests.md`.

## Open decisions (need the owner, not blocking M1)
1. **Root app**: keep the Vite assessment designer at the repo root (current) or retire it later.
2. **Which first textbook** (and proof of licence) for the pilot; the pipeline is generic but heuristics (lesson headings) need tuning on the real PDF.
3. **Provider accounts**: Supabase project, OpenAI key (embeddings + vision + realtime), Vercel project, worker host.
4. **School policy**: retention period, guardian consent mechanism, DSL escalation contact — placeholders exist in code but must be set by the school.
