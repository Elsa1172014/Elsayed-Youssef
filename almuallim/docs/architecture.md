# Architecture — Al-Muallim Al-Arabi AI

> This document describes the **target design**. Per-feature build/verification status is the single source of truth in `implementation-plan.md` (milestone table) — a section here being present does not mean it is built.
>
> Status legend used across the docs: ✅ implemented **and** verified by an automated test or a command run in this repo · 🟡 implemented, **unverified against the live external service** (needs credentials) · ⬜ not yet built.

## 1. Repository layout and the existing project

The repository root already contains a working, unrelated Vite/React app (the *Arabic Assessment Designer*). It is **left untouched**. The tutor platform lives in `almuallim/` and deploys to Vercel with **Root Directory = `almuallim`**. If you want the tutor to replace the root app instead, that is a deliberate follow-up decision (see `implementation-plan.md`, "Open decisions").

```
almuallim/
  src/app/            Next.js App Router (RTL UI, route handlers)
  src/lib/            Typed service layer (auth, ingestion, retrieval, tutor, vision, voice, providers)
  worker/             Durable ingestion worker (separate Node process, Dockerfile)
  supabase/migrations PostgreSQL schema, functions, RLS, storage buckets
  tests/unit          Vitest unit tests (pure logic, mocked providers)
  tests/db            Vitest tests against a REAL PostgreSQL 16 + pgvector (RLS, queue, hybrid search)
  docs/               This folder
```

## 2. Runtime topology

```
 Browser (Next.js client, RTL)                     Vercel (Next.js route handlers)                 Managed services
 ┌──────────────────────────────┐                  ┌───────────────────────────────┐              ┌────────────────────┐
 │ Camera (getUserMedia)        │  JPEG frame      │ /api/vision/recognize         │─ vision LLM ▶│ OpenAI (vision)    │
 │  └ stability detector        │ ───────────────▶ │  ├ OCR-style transcription    │              └────────────────────┘
 │ Mic ⇄ WebRTC audio           │                  │  └ match_pages (hybrid)       │─ pgvector ──▶┌────────────────────┐
 │  └ RealtimeVoiceClient (FSM) │  ephemeral token │ /api/realtime/token           │              │ Supabase           │
 │ Transcript / lesson card     │ ◀─────────────── │  (mints short-lived secret)   │              │  Auth (JWT)        │
 │ Text fallback chat           │  tool calls      │ /api/realtime/tool            │              │  Postgres+pgvector │
 └───────┬──────────────────────┘ ───────────────▶ │  (search/page/record)         │─────────────▶│  Storage (private) │
         │ WebRTC (SDP via /v1/realtime/calls)     │ /api/tutor/chat (AI SDK)      │              └─────────┬──────────┘
         ▼                                         │ /api/admin/*  /api/privacy/*  │                        │ claim_ingestion_job()
 ┌──────────────────────┐                          └───────────────────────────────┘                        ▼
 │ OpenAI Realtime API  │                                                                        ┌────────────────────┐
 └──────────────────────┘                                                                        │ Ingestion worker   │
                                                                                                 │ (Node, Docker)     │
                                                                                                 └────────────────────┘
```

* **Browser never holds a permanent secret.** It holds a Supabase user JWT and, for voice, a short-lived OpenAI client secret minted by `/api/realtime/token` only after auth, role, rate-limit and budget checks.
* **Audio goes browser ⇄ provider directly** (WebRTC) for latency; the server never proxies audio. Transcripts and tool calls are persisted by the client through authenticated endpoints.
* **The server is the only holder of the Supabase service-role key**, used for the worker, rate limiting, usage ledger, AI-written scores and privacy export/delete.

## 3. Key decisions and why

| Decision | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 App Router, React 19, TypeScript, Tailwind 4 | Requested; builds verified (`npm run build`). |
| Text LLM / tools | Vercel **AI SDK 7** (`ai`, `@ai-sdk/openai`), `generateText`/`streamText`, `tool()` with Zod `inputSchema`, `Output.object` | API shapes verified against the docs bundled in `node_modules/ai/docs`, not memory. Models are config (`TUTOR_MODEL`, etc.). |
| Realtime voice | **OpenAI Realtime API over WebRTC** with server-minted ephemeral client secrets, behind `RealtimeProvider` adapter | Native barge-in/VAD, low latency, supports Arabic, short-lived credentials. The AI SDK's realtime helpers are marked *experimental*; the adapter talks to the documented HTTP/WebRTC surface directly so the transport can be swapped. |
| Vision | Provider adapter `PageRecognizer`; default: multimodal model transcribes visible printed text + printed page number, then **matching is done against our own index** | The model is never asked "which page is this" from memory — it only reads text. Identity comes from retrieval over the uploaded book, with explicit confidence and ambiguity handling. |
| Retrieval | Hybrid: pgvector HNSW cosine + Postgres FTS (`simple` over Arabic-normalised text), fused with RRF in SQL (`search_content`) | No Arabic stemmer ships in Postgres; deterministic Arabic normalisation (diacritics, alef/ya/ta-marbuta, tatweel, digits) is applied identically at index and query time (`src/lib/arabic/normalize.ts`). |
| Embeddings | `text-embedding-3-small`, 1536-d, behind `EmbeddingProvider` | Fixed dimension in schema; swapping dimension = new migration + re-embed job. |
| Job queue | **PostgreSQL-backed queue** (`ingestion_jobs`, `FOR UPDATE SKIP LOCKED`, leases, heartbeat, exponential backoff, idempotency key) + separate Node worker | Durable, no extra vendor, transactionally consistent with the data it writes, fully testable locally. Vercel functions are unsuitable for multi-minute PDF work. Worker host: any container runtime (Fly.io / Railway / Render); `worker/Dockerfile`. |
| Authorisation | Supabase Auth + RLS as the primary control; route handlers add role checks, validation, rate limits | Defence in depth; RLS verified on a real Postgres in `tests/db`. |
| Textbook copyright | Admin must attest licensing at upload (stored on `books`); raw `book_pages`/`content_chunks` are **staff-only** under RLS; students receive bounded excerpts (≤12 chunks/call) via `search_content` | Prevents the student API from being a bulk textbook export. |

## 4. Data model (see `supabase/migrations/0001_schema.sql`)

`profiles`, `classes`, `class_members`, `books`, `book_versions`, `book_pages`, `lessons`, `content_chunks`, `ingestion_jobs`, `tutoring_sessions`, `session_events`, `assessments`, `assessment_items`, `student_responses`, `skill_mastery`, `audit_logs` (+ `rate_limits`, `usage_ledger` for ceilings).

Provenance rules baked into the schema:
* Every chunk carries `book_version_id`, `lesson_id`, `page_start/page_end` → citations are always derivable, never invented.
* `student_responses` keeps **`ai_*` columns and `teacher_*` columns separately**; a trigger stamps the validating teacher and blocks students from writing either. `skill_mastery` likewise keeps `ai_estimate` vs `teacher_validated`. UI labels the former "تقدير آلي" and the latter "تقييم المعلّم".
* `audit_logs` is append-only (trigger), even against the service role.

## 5. Ingestion pipeline (stages are resumable and idempotent)

`queued → download → extract → images → lessons → chunk → embed → finalize → done`

1. Admin creates a book + version (licence attestation required) and uploads the PDF to the private `textbooks` bucket via a **server-issued signed upload URL**; SHA-256 of the file is recorded.
2. `enqueue_ingestion` inserts a job keyed by `ingest:<version>:<sha256>`; re-enqueueing is a no-op unless `force`.
3. Worker `claim_ingestion_job` (SKIP LOCKED, 120 s lease, heartbeats). Crash ⇒ lease expires ⇒ another worker resumes; attempts capped (default 5) with exponential backoff; terminal failure marks the version `failed` with an error.
4. Extract per-page text with positioned text items (pdf.js via `unpdf`); pages without a text layer are flagged `has_text=false` (scanned) and optionally OCR'd through the vision adapter when `INGEST_OCR=1`.
5. Render page images with `pdftoppm` (poppler) when available in the worker image; upsert to `page-images`.
6. Lesson boundaries: PDF outline first; otherwise heading heuristics (الدرس / الوحدة / النص …) using font-size outliers; otherwise a single whole-document lesson. Learning objectives are **left empty** for a teacher to fill/verify — never invented.
7. Chunk (page-aware, ~350–600 tokens, sentence/verse-boundary aware), embed in batches, upsert by `(book_version_id, ordinal)` with content hash so re-runs skip unchanged chunks.

## 6. Page recognition (camera → context)

1. Client `getUserMedia({video:{facingMode:"environment"}})`; permission states are modelled explicitly (prompt / granted / denied / no-device / insecure-context).
2. A stability detector (frame-difference + Laplacian sharpness on a down-scaled canvas) decides when a frame is *steady and sharp*; capture is on demand or after N stable frames. **Nothing is sent continuously.** The UI says "تم التقاط الصفحة" per capture, not "I see your book".
3. `/api/vision/recognize` transcribes the frame, then `match_pages` returns candidates; `decideMatch()` (pure, unit-tested) yields `confident | ambiguous | none` from: top score, margin to runner-up, printed page-number agreement, text coverage.
4. `confident` still shows a confirm chip; `ambiguous` forces the student to pick among top candidates; `none` asks to retake/enter page manually.
5. `/api/vision/confirm` writes `tutoring_sessions.current_page/lesson_id`, a `page_confirmed` event, and returns validated context. If a voice session is live the client pushes that context into it (`conversation.item.create` + `session.update`) without reconnecting.

## 7. Tutor (grounded RAG)

* Tools exposed to the model: `search_textbook`, `get_page`, `get_lesson_outline`, `propose_question`, `evaluate_response`, `record_mastery_evidence` (Zod-validated; run server-side under the caller's identity).
* Structured answer segments distinguish `quote` (verbatim from a retrieved chunk, with chunk id + page) from `explanation` (generated). A post-check verifies each quote is a substring of the cited chunk (after normalisation) and drops/marks any that is not — fabricated citations are rejected in code, not just by prompt.
* `groundingGate()` refuses curriculum-specific answers when retrieval confidence is below threshold and instead says so in Arabic and offers to look elsewhere / ask the teacher.
* Modes (`explain | socratic | practice | assessment | review`) change the system prompt and the allowed tools; "never complete the exercise" is enforced in the prompt **and** by an output check in assessment/practice modes.

## 8. Voice session

`RealtimeVoiceClient` is a pure state machine (`idle → requesting-mic → fetching-token → connecting → live ⇄ muted/model-speaking/user-speaking → reconnecting → ended | error`) over an injectable transport, so every state transition is unit-tested without a browser or network. The WebRTC transport is the only part requiring a live provider. Interruption relies on server VAD `interrupt_response`; on barge-in the client truncates playback (`conversation.item.truncate`) so the transcript reflects what the student actually heard. Mobile limits (iOS Safari autoplay/AudioContext unlock, background suspension) are handled by requiring a user gesture to start and by reconnect-on-resume.

## 9. Security, privacy, minors

* RLS everywhere; `service_role` only in server code and the worker. Secrets only in env; `.env.example` has names only.
* Zod validation on every route; `rate_limit_hit` (fixed window, Postgres) per user and per route; `usage_ledger` + per-user/day and global/day ceilings checked **before** calling paid providers.
* Data minimisation: no email/phone/DOB/photo in `profiles`; camera frames are processed in memory and **not stored** (only the recognised page reference is); transcripts retained per-profile preference with scheduled deletion; no training use (provider calls set `store: false` where supported and we do not send identifiers).
* Self-service export (`/api/privacy/export`) and deletion (`/api/privacy/delete`) with audit entries; teacher/admin deletion on behalf of a student is an audited admin action.
* Safe handling of minors: age-appropriate system prompt, refusal/redirect rules for off-topic or sensitive disclosures (tutor tells the student to speak to a trusted adult/teacher and flags the session for teacher review), no open-ended social features, no personal-info solicitation. **Policy review by the school's DSL/DPO is required before pilot** — this repo provides mechanisms, not legal compliance.

## 10. Observability

Structured JSON logs (`src/lib/logger.ts`) with request ids, redaction of tokens/transcripts, and per-stage ingestion timings; job progress is queryable from `ingestion_jobs.progress`.
